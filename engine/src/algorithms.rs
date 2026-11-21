//! The algorithm tables of the engine: what it offers when the ssh config says nothing, and what
//! a host may ask for on top.
//!
//! The defaults keep what old network gear needs (ECDH-NIST, SHA-1 MACs, ssh-rsa), and the legacy
//! key exchanges, CBC and 3DES ciphers and ssh-dss stay available on request. The TypeScript side
//! applies the ssh_config list syntax (`+`, `^`, `-`, patterns) against these tables and hands the
//! final lists to a connection.

use std::borrow::Cow;

use napi_derive::napi;
use russh::keys::{Algorithm, EcdsaCurve, HashAlg};
use russh::{Preferred, cipher, compression, kex, mac};

const DEFAULT_KEX: &[&str] = &[
    "mlkem768x25519-sha256",
    "curve25519-sha256",
    "curve25519-sha256@libssh.org",
    "ecdh-sha2-nistp256",
    "ecdh-sha2-nistp384",
    "ecdh-sha2-nistp521",
    "diffie-hellman-group-exchange-sha256",
    "diffie-hellman-group14-sha256",
    "diffie-hellman-group15-sha512",
    "diffie-hellman-group16-sha512",
    "diffie-hellman-group17-sha512",
    "diffie-hellman-group18-sha512",
];

const LEGACY_KEX: &[&str] = &[
    "diffie-hellman-group-exchange-sha1",
    "diffie-hellman-group14-sha1",
    "diffie-hellman-group1-sha1",
];

const DEFAULT_HOST_KEY: &[&str] = &[
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "rsa-sha2-512",
    "rsa-sha2-256",
    "ssh-rsa",
];

const LEGACY_HOST_KEY: &[&str] = &["ssh-dss"];

const DEFAULT_CIPHER: &[&str] = &[
    "aes128-gcm@openssh.com",
    "aes256-gcm@openssh.com",
    "aes128-ctr",
    "aes192-ctr",
    "aes256-ctr",
    "chacha20-poly1305@openssh.com",
];

const LEGACY_CIPHER: &[&str] = &["aes256-cbc", "aes192-cbc", "aes128-cbc", "3des-cbc"];

const DEFAULT_MAC: &[&str] = &[
    "hmac-sha2-256-etm@openssh.com",
    "hmac-sha2-512-etm@openssh.com",
    "hmac-sha1-etm@openssh.com",
    "hmac-sha2-256",
    "hmac-sha2-512",
    "hmac-sha1",
];

const DEFAULT_COMPRESSION: &[&str] = &["none", "zlib@openssh.com", "zlib"];

/// One category: the names offered by default, and every name that can be negotiated.
#[napi(object)]
pub struct AlgorithmList {
    pub defaults: Vec<String>,
    pub supported: Vec<String>,
}

#[napi(object)]
pub struct AlgorithmSupport {
    pub kex: AlgorithmList,
    pub host_key: AlgorithmList,
    pub cipher: AlgorithmList,
    pub mac: AlgorithmList,
    pub compression: AlgorithmList,
}

fn list(defaults: &[&str], legacy: &[&str]) -> AlgorithmList {
    AlgorithmList {
        defaults: defaults.iter().map(|s| s.to_string()).collect(),
        supported: defaults
            .iter()
            .chain(legacy)
            .map(|s| s.to_string())
            .collect(),
    }
}

/// The engine's algorithm tables.
#[napi]
pub fn algorithm_support() -> AlgorithmSupport {
    AlgorithmSupport {
        kex: list(DEFAULT_KEX, LEGACY_KEX),
        host_key: list(DEFAULT_HOST_KEY, LEGACY_HOST_KEY),
        cipher: list(DEFAULT_CIPHER, LEGACY_CIPHER),
        mac: list(DEFAULT_MAC, &[]),
        compression: list(DEFAULT_COMPRESSION, &[]),
    }
}

fn host_key_algorithm(name: &str) -> Option<Algorithm> {
    Some(match name {
        "ssh-ed25519" => Algorithm::Ed25519,
        "ecdsa-sha2-nistp256" => Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP256,
        },
        "ecdsa-sha2-nistp384" => Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP384,
        },
        "ecdsa-sha2-nistp521" => Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP521,
        },
        "rsa-sha2-512" => Algorithm::Rsa {
            hash: Some(HashAlg::Sha512),
        },
        "rsa-sha2-256" => Algorithm::Rsa {
            hash: Some(HashAlg::Sha256),
        },
        "ssh-rsa" => Algorithm::Rsa { hash: None },
        "ssh-dss" => Algorithm::Dsa,
        _ => return None,
    })
}

/// The lists a connection asks for; `None` keeps the default of that category.
#[derive(Default)]
pub struct Requested {
    pub kex: Option<Vec<String>>,
    pub host_key: Option<Vec<String>>,
    pub cipher: Option<Vec<String>>,
    pub mac: Option<Vec<String>>,
    pub compression: Option<Vec<String>>,
}

fn names<'a>(requested: &'a Option<Vec<String>>, defaults: &'a [&'a str]) -> Vec<&'a str> {
    match requested {
        Some(list) => list.iter().map(String::as_str).collect(),
        None => defaults.to_vec(),
    }
}

/// The negotiation lists for one connection. Names the engine does not know are left out; the
/// TypeScript side has already told the user about them.
pub fn preferred(requested: &Requested) -> Preferred {
    let mut kex: Vec<kex::Name> = names(&requested.kex, DEFAULT_KEX)
        .into_iter()
        .filter_map(|n| kex::Name::try_from(n).ok())
        .collect();
    // Markers every client list carries: RFC 8308 extension info and OpenSSH's strict kex.
    kex.push(kex::EXTENSION_SUPPORT_AS_CLIENT);
    kex.push(kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT);
    Preferred {
        kex: Cow::Owned(kex),
        key: Cow::Owned(
            names(&requested.host_key, DEFAULT_HOST_KEY)
                .into_iter()
                .filter_map(host_key_algorithm)
                .collect(),
        ),
        host_key_certificates: Cow::Borrowed(&[]),
        cipher: Cow::Owned(
            names(&requested.cipher, DEFAULT_CIPHER)
                .into_iter()
                .filter_map(|n| cipher::Name::try_from(n).ok())
                .collect(),
        ),
        mac: Cow::Owned(
            names(&requested.mac, DEFAULT_MAC)
                .into_iter()
                .filter_map(|n| mac::Name::try_from(n).ok())
                .collect(),
        ),
        compression: Cow::Owned(
            names(&requested.compression, DEFAULT_COMPRESSION)
                .into_iter()
                .filter_map(|n| compression::Name::try_from(n).ok())
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_supported_name_is_one_the_engine_negotiates() {
        let support = algorithm_support();
        for name in &support.kex.supported {
            assert!(kex::Name::try_from(name.as_str()).is_ok(), "kex {name}");
        }
        for name in &support.cipher.supported {
            assert!(
                cipher::Name::try_from(name.as_str()).is_ok(),
                "cipher {name}"
            );
        }
        for name in &support.mac.supported {
            assert!(mac::Name::try_from(name.as_str()).is_ok(), "mac {name}");
        }
        for name in &support.compression.supported {
            assert!(
                compression::Name::try_from(name.as_str()).is_ok(),
                "compression {name}"
            );
        }
        for name in &support.host_key.supported {
            assert!(host_key_algorithm(name).is_some(), "host key {name}");
        }
    }

    #[test]
    fn a_requested_list_replaces_the_default_and_keeps_its_order() {
        let preferred = preferred(&Requested {
            cipher: Some(vec!["3des-cbc".into(), "aes128-ctr".into(), "nope".into()]),
            ..Requested::default()
        });
        let ciphers: Vec<&str> = preferred.cipher.iter().map(|c| c.as_ref()).collect();
        assert_eq!(ciphers, ["3des-cbc", "aes128-ctr"]);
        assert_eq!(preferred.mac.len(), DEFAULT_MAC.len());
    }
}
