// The manifest key fixes the extension ID for every unpacked copy, whatever folder it is loaded from.
// It is a public identifier, not a secret: any developer-mode extension could reuse it, which the
// installation accepts so that new users connect without copying IDs. Never put a private key here.
export const EXTENSION_PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5XT6yqucp+WLKum3MNAI+N9Vb8BYLvM4yhmxgj15uDPTyNXIzyV97YeO8xNoDiCo3iY1Dt86IL6W2khhJtD9DPmz3ow5hl9nLZjMbeFmTsqYWUAamohDelFMceeVCIKVQKjhWe805J7xQH45b3IBA85YTp/Ki3BSd1L0PtSm2SdqJxagcgV+yaRv+klkeB1xc7D8oucFcqbKf0yH8L3PcVb6QmyfvWMU1q7k6DHim9qRTUNznot6uXIvzdARUicVmErnV5oYG4wxrSog7eBoBKaKUDeb/Dixb4B4DRfbzAMz4WxDXvjUeI2FgUHeK+b7Xakmv3qlFFwUosrHTl1AdwIDAQAB";
// Chromium derives it from SHA-256 of the key's DER bytes; tests/connection.test.mjs checks the pair.
export const EXTENSION_ID = "lmnmccbogohpiagjbmpaiagaoddhkpgf";
