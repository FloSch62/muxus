//! Private key files: OpenSSH, PEM (PKCS#1, PKCS#5, PKCS#8) and PuTTY formats.

use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use russh::keys::{HashAlg, PrivateKey};

use crate::error::coded;

/// A private key held in memory for one login.
#[napi]
pub struct SshPrivateKey {
    pub(crate) key: Arc<PrivateKey>,
}

/// Whether the file says its private part is protected by a passphrase.
fn looks_encrypted(text: &str) -> bool {
    if text.contains("Proc-Type: 4,ENCRYPTED") || text.contains("BEGIN ENCRYPTED PRIVATE KEY") {
        return true;
    }
    if let Some(line) = text.lines().find(|line| line.starts_with("Encryption:")) {
        return line["Encryption:".len()..].trim() != "none";
    }
    openssh_cipher(text).is_some_and(|cipher| cipher != "none")
}

/// The cipher named in the unencrypted header of an OpenSSH private key file.
fn openssh_cipher(text: &str) -> Option<String> {
    use russh::keys::ssh_encoding::base64::{Base64, Encoding};
    let body = text
        .split("-----BEGIN OPENSSH PRIVATE KEY-----")
        .nth(1)?
        .split("-----END OPENSSH PRIVATE KEY-----")
        .next()?;
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    // The magic and the cipher name sit in the first bytes; decode a whole number of groups.
    let head = &compact[..compact.len().min(96) / 4 * 4];
    let bytes = Base64::decode_vec(head).ok()?;
    let rest = bytes.strip_prefix(b"openssh-key-v1\0")?;
    let length = u32::from_be_bytes(rest.get(..4)?.try_into().ok()?) as usize;
    Some(String::from_utf8_lossy(rest.get(4..4 + length)?).into_owned())
}

/// A PEM key protected the way OpenSSL's traditional format does it: a `DEK-Info` header
/// names the cipher and its IV, and the key comes from the passphrase by one round of MD5.
/// Older `openssl` and many appliances write RSA and EC keys like this, with 3DES or AES.
struct LegacyPem<'a> {
    label: &'a str,
    cipher: &'a str,
    iv: Vec<u8>,
    body: Vec<u8>,
}

impl<'a> LegacyPem<'a> {
    fn parse(text: &'a str) -> Option<Self> {
        use russh::keys::ssh_encoding::base64::{Base64, Encoding};
        let mut lines = text.lines().map(str::trim);
        let label = lines
            .find_map(|line| line.strip_prefix("-----BEGIN "))?
            .strip_suffix("-----")?;
        let mut encrypted = false;
        let mut dek = None;
        let mut body = String::new();
        for line in lines {
            if line.starts_with("-----END ") {
                break;
            }
            if line == "Proc-Type: 4,ENCRYPTED" {
                encrypted = true;
            } else if let Some(info) = line.strip_prefix("DEK-Info:") {
                dek = info.trim().split_once(',');
            } else if !line.contains(':') {
                body.push_str(line);
            }
        }
        let (cipher, iv) = dek.filter(|_| encrypted)?;
        let iv = (0..iv.len() / 2)
            .map(|i| u8::from_str_radix(iv.get(i * 2..i * 2 + 2)?, 16).ok())
            .collect::<Option<Vec<u8>>>()?;
        Some(Self {
            label,
            cipher,
            iv,
            body: Base64::decode_vec(&body).ok()?,
        })
    }

    /// OpenSSL's `EVP_BytesToKey` with MD5 and no iterations, salted with the IV's first half.
    fn key(&self, passphrase: &str, length: usize) -> Option<Vec<u8>> {
        let salt = self.iv.get(..8)?;
        let mut key = Vec::new();
        let mut block: Vec<u8> = Vec::new();
        while key.len() < length {
            let mut hash = md5::Context::new();
            hash.consume(&block);
            hash.consume(passphrase.as_bytes());
            hash.consume(salt);
            block = hash.finalize().0.to_vec();
            key.extend_from_slice(&block);
        }
        key.truncate(length);
        Some(key)
    }

    /// The same key file without its protection. `None` when the passphrase does not fit or
    /// the cipher is not one of the four that were ever common.
    fn decrypt(&self, passphrase: &str) -> Option<String> {
        use aes::cipher::{BlockModeDecrypt, KeyIvInit, block_padding::Pkcs7};
        use russh::keys::ssh_encoding::base64::{Base64, Encoding};
        let mut data = self.body.clone();
        let plain = match self.cipher {
            "AES-128-CBC" => {
                cbc::Decryptor::<aes::Aes128>::new_from_slices(&self.key(passphrase, 16)?, &self.iv)
                    .ok()?
                    .decrypt_padded::<Pkcs7>(&mut data)
                    .ok()?
            }
            "AES-192-CBC" => {
                cbc::Decryptor::<aes::Aes192>::new_from_slices(&self.key(passphrase, 24)?, &self.iv)
                    .ok()?
                    .decrypt_padded::<Pkcs7>(&mut data)
                    .ok()?
            }
            "AES-256-CBC" => {
                cbc::Decryptor::<aes::Aes256>::new_from_slices(&self.key(passphrase, 32)?, &self.iv)
                    .ok()?
                    .decrypt_padded::<Pkcs7>(&mut data)
                    .ok()?
            }
            "DES-EDE3-CBC" => cbc::Decryptor::<des::TdesEde3>::new_from_slices(
                &self.key(passphrase, 24)?,
                &self.iv,
            )
            .ok()?
            .decrypt_padded::<Pkcs7>(&mut data)
            .ok()?,
            _ => return None,
        };
        Some(format!(
            "-----BEGIN {label}-----\n{}\n-----END {label}-----\n",
            Base64::encode_string(plain),
            label = self.label,
        ))
    }
}

#[napi]
impl SshPrivateKey {
    /// Parse a key file. A protected key without `passphrase` fails with `KEY_ENCRYPTED`;
    /// anything else that cannot be read, a wrong passphrase included, with `KEY_INVALID`.
    #[napi(factory)]
    pub fn parse(data: Buffer, passphrase: Option<String>) -> Result<SshPrivateKey> {
        let text = String::from_utf8_lossy(&data);
        let passphrase = passphrase.filter(|p| !p.is_empty());
        if let (Some(legacy), Some(passphrase)) = (LegacyPem::parse(&text), &passphrase) {
            let wrong = || coded("KEY_INVALID", "the passphrase does not fit the private key");
            let plain = legacy.decrypt(passphrase).ok_or_else(wrong)?;
            // A wrong passphrase can leave valid padding and nonsense behind it.
            let key = russh::keys::decode_secret_key(&plain, None).map_err(|_| wrong())?;
            return Ok(SshPrivateKey { key: Arc::new(key) });
        }
        match russh::keys::decode_secret_key(&text, passphrase.as_deref()) {
            Ok(key) => Ok(SshPrivateKey { key: Arc::new(key) }),
            Err(russh::keys::Error::KeyIsEncrypted) if passphrase.is_none() => Err(coded(
                "KEY_ENCRYPTED",
                "the private key is protected by a passphrase",
            )),
            Err(_) if passphrase.is_none() && looks_encrypted(&text) => Err(coded(
                "KEY_ENCRYPTED",
                "the private key is protected by a passphrase",
            )),
            Err(err) => Err(coded("KEY_INVALID", err.to_string())),
        }
    }

    /// The key type as SSH names it, such as `ssh-ed25519` or `ssh-rsa`.
    #[napi(getter)]
    pub fn key_type(&self) -> String {
        self.key.public_key().algorithm().as_str().to_string()
    }

    #[napi(getter)]
    pub fn comment(&self) -> String {
        self.key.comment().to_string()
    }

    /// The public half in SSH wire format.
    #[napi]
    pub fn public_blob(&self) -> Result<Buffer> {
        self.key
            .public_key()
            .to_bytes()
            .map(Buffer::from)
            .map_err(|err| coded("KEY_INVALID", err.to_string()))
    }
}

pub fn hash_from_name(name: Option<&str>) -> Result<Option<HashAlg>> {
    match name {
        None | Some("sha1") => Ok(None),
        Some("sha256") => Ok(Some(HashAlg::Sha256)),
        Some("sha512") => Ok(Some(HashAlg::Sha512)),
        Some(other) => Err(coded("INVALID_ARGUMENT", format!("unknown hash {other}"))),
    }
}

/// An SSH signature blob made with a private key; `hash` picks the RSA variant.
pub fn sign(key: &PrivateKey, hash: Option<HashAlg>, data: &[u8]) -> Result<Vec<u8>> {
    use russh::keys::signature::Signer;
    use russh::keys::ssh_encoding::Encode;
    use russh::keys::ssh_key::private::KeypairData;
    let invalid =
        |err: &dyn std::fmt::Display| coded("KEY_INVALID", format!("could not sign: {err}"));
    let signature: russh::keys::ssh_key::Signature = match key.key_data() {
        KeypairData::Rsa(rsa) => Signer::try_sign(&(rsa, hash), data).map_err(|e| invalid(&e))?,
        keypair => Signer::try_sign(keypair, data).map_err(|e| invalid(&e))?,
    };
    let mut out = Vec::new();
    signature.encode(&mut out).map_err(|e| invalid(&e))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENCRYPTED_PEM: &str = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,00\n\nAAAA\n-----END RSA PRIVATE KEY-----\n";

    // A throwaway P-256 key made for this test, protected with the passphrase below.
    const PASSPHRASE: &str = "fixture-pass";
    const PUBLIC: &str = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBOUqwSspRrjRNWSCbSIshOXjQ0XGqronUIupnaxHbTOy67RNhuQ4Tb8Tpif7q5BPSIR3qTcaSAsJx7Xm2jDPd20=";
    const AES_256: &str = "-----BEGIN EC PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-256-CBC,3DEE36021A63CBEBCC2D6F855109B17B

mDb7vNIQCUAS/zD9gdXLUaWBAnum6Qx8hIDAmUjF3g4FAUcAnw0h0Bk4hKroXJP2
yNpJVkEPdIikeRQNJu7F+uuwRI8g/NjS2Pfb1V9HjqKHB8noPVtR9jFg2smpT4Po
I28DO9zlbwlQGTihFnrI3/KujZTsRCDD17jL8twuTfg=
-----END EC PRIVATE KEY-----
";
    const TRIPLE_DES: &str = "-----BEGIN EC PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: DES-EDE3-CBC,A074A42FE155CE1C

hWVxpKdEBbEEZHtcif+kbPxR7bEdqSj66S8xvifcTVOpm5d+C7RCchV24O5lXuAI
9b7rg3ua7w4dl3JXOw6xhsY8GsbO6NnbmvFCQi2/UmXCrwEgtfxJmrqvB5rdxUIq
ZZwJzrFySgDKxv+FwaSRmIa526afy8Dm4UsERLE9X5k=
-----END EC PRIVATE KEY-----
";

    #[test]
    fn a_legacy_pem_key_opens_with_its_passphrase_whatever_cipher_protects_it() {
        use russh::keys::ssh_encoding::base64::{Base64, Encoding};
        for file in [AES_256, TRIPLE_DES] {
            let legacy = LegacyPem::parse(file).expect("a legacy PEM file");
            let plain = legacy.decrypt(PASSPHRASE).expect("the passphrase fits");
            let key = russh::keys::decode_secret_key(&plain, None).expect("an EC key");
            let blob = key.public_key().to_bytes().unwrap();
            assert_eq!(Base64::encode_string(&blob), PUBLIC);
            // A wrong passphrase fails here or leaves nothing a key could be read from.
            let wrong = legacy.decrypt("not-the-passphrase");
            assert!(
                wrong.is_none_or(|plain| russh::keys::decode_secret_key(&plain, None).is_err())
            );
            assert!(looks_encrypted(file));
        }
        // Not this format: an OpenSSH key file, and a PEM file without protection.
        assert!(
            LegacyPem::parse(
                "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n"
            )
            .is_none()
        );
        assert!(
            LegacyPem::parse(
                "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n"
            )
            .is_none()
        );
    }

    #[test]
    fn a_protected_key_is_told_apart_from_a_broken_one() {
        assert!(looks_encrypted(ENCRYPTED_PEM));
        assert!(looks_encrypted(
            "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: aes256-cbc\n"
        ));
        assert!(!looks_encrypted(
            "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n"
        ));
        assert!(!looks_encrypted(
            "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n"
        ));
    }
}
