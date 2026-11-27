// The manifest key fixes the extension ID for every unpacked copy, whatever folder it is loaded from.
// It is a public identifier, not a secret: any developer-mode extension could reuse it, which the
// installation accepts so that new users connect without copying IDs. Never put a private key here.
export const EXTENSION_PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5XT6yqucp+WLKum3MNAI+N9Vb8BYLvM4yhmxgj15uDPTyNXIzyV97YeO8xNoDiCo3iY1Dt86IL6W2khhJtD9DPmz3ow5hl9nLZjMbeFmTsqYWUAamohDelFMceeVCIKVQKjhWe805J7xQH45b3IBA85YTp/Ki3BSd1L0PtSm2SdqJxagcgV+yaRv+klkeB1xc7D8oucFcqbKf0yH8L3PcVb6QmyfvWMU1q7k6DHim9qRTUNznot6uXIvzdARUicVmErnV5oYG4wxrSog7eBoBKaKUDeb/Dixb4B4DRfbzAMz4WxDXvjUeI2FgUHeK+b7Xakmv3qlFFwUosrHTl1AdwIDAQAB";
// Chromium derives it from SHA-256 of the key's DER bytes; tests/connection.test.mjs checks the pair.
export const EXTENSION_ID = "lmnmccbogohpiagjbmpaiagaoddhkpgf";

// The dev build (`npm run dev`, `npm run dev:build`) loads with its own fixed ID, so a developer can run it beside an
// installed release without either service trusting the other extension. Its private key was discarded as well.
export const DEV_EXTENSION_PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAipgMWEIRh38WxDWIMy3jGTOgMgrvkl2DqxY1U96iLn6etH+dUXYm62tp/1khrSRV4PXAOLOzhpjMvOfE3HHT//m23//EtcMdyUQ6Oh8Ev7l6ZDoDZ3+SLXMBagWUsNezYmKEH4c1sY2kCoToqK/phHWW/qHsP6cqp3lm/yCGIKZDqqwJpcTM3wWdod1CaEuMzYL1AadX85574LOsI9fO0xAWaKpVSXoHY2qpJ0r3F+p6eWgQmQW9LKTmK+nfBlh/GdzG/P5b7uDZktR1jBLloFWt/oUycvAmoSI4YwxWTz2Ic0zC1ffUP4iVlCUrk/irT0d3fLY2F/uFY4QYaFDBUwIDAQAB";
export const DEV_EXTENSION_ID = "eefikhmhfflkjpefegnffhhmikfphldf";
