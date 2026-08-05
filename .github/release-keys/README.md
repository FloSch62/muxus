# Release keys

This directory contains public keys only. Private release keys and signing subkeys must
never be committed.

The Linux release job requires `linux-signing-key.asc` to match the restricted private
signing subkey stored in the `linux-release-signing` GitHub environment. Provisioning and
rotation are restricted to the designated Muxus release-key custodian.

The Muxus Linux release key has primary fingerprint:

```text
9961 EE0F 767C A411 D2F5 9489 E330 0BC6 4E4A DE67
```
