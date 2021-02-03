import * as nacl from "tweetnacl";
import { Ed25519PublicKey } from "./Ed25519PublicKey";
import { Mnemonic } from "./Mnemonic";
import {
    arraysEqual,
    legacyDeriveChildKey,
    deriveChildKey,
    deriveChildKey2,
    ed25519PrivKeyPrefix
} from "./util";
import { RawKeyPair } from "./RawKeyPair";
import { createKeystore, loadKeystore } from "./Keystore";
import { BadKeyError } from "../errors/BadKeyError";
import { BadPemFileError } from "../errors/BadPemFileError";
import { EncryptedPrivateKeyInfo } from "./pkcs";
import { decodeDer } from "./der";
// import * as base64 from "@stablelib/base64";
import * as base64 from "../encoding/base64";
import * as hex from "@stablelib/hex";
import { Hmac, HashAlgorithm } from "./Hmac";
import { Pbkdf2 } from "./Pbkdf2";

const beginPrivateKey = "-----BEGIN PRIVATE KEY-----\n";
const endPrivateKey = "-----END PRIVATE KEY-----\n";

const beginEncryptedPkey = "-----BEGIN ENCRYPTED PRIVATE KEY-----\n";
const endEncryptedPkey = "-----END ENCRYPTED PRIVATE KEY-----\n";

const derPrefix = hex.decode("302e020100300506032b657004220420");

function _bytesLengthCases(bytes: Uint8Array): nacl.SignKeyPair {
    // this check is necessary because Jest breaks the prototype chain of Uint8Array
    // noinspection SuspiciousTypeOfGuard
    const bytesArray =
        bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);

    switch (bytes.length) {
        case 48:
            // key with prefix
            if (arraysEqual(bytesArray.subarray(0, 16), derPrefix)) {
                return nacl.sign.keyPair.fromSeed(bytesArray.subarray(16));
            }
            break;
        case 32:
            // fromSeed takes the private key bytes and calculates the public key
            return nacl.sign.keyPair.fromSeed(bytesArray);
        case 64:
            // priv + pub key pair
            return nacl.sign.keyPair.fromSecretKey(bytesArray);
        default:
    }
    throw new BadKeyError();
}

export class Ed25519PrivateKey {
    public readonly publicKey: Ed25519PublicKey;

    // NOT A STABLE API
    public readonly _keyData: Uint8Array;
    private _asStringRaw?: string;
    private _chainCode?: Uint8Array;

    private constructor({ privateKey, publicKey }: RawKeyPair) {
        if (privateKey.length !== nacl.sign.secretKeyLength) {
            throw new BadKeyError();
        }

        this._keyData = privateKey;
        this.publicKey = Ed25519PublicKey.fromBytes(publicKey);
    }

    /**
     * Recover a private key from its raw bytes form.
     *
     * This key will _not_ support child key derivation.
     */
    public static fromBytes(bytes: Uint8Array): Ed25519PrivateKey {
        const keypair = _bytesLengthCases(bytes);

        const { secretKey: privateKey, publicKey } = keypair;

        return new Ed25519PrivateKey({ privateKey, publicKey });
    }

    /**
     * Recover a key from a hex-encoded string.
     *
     * This key will _not_ support child key derivation.
     */
    public static fromString(keyStr: string): Ed25519PrivateKey {
        switch (keyStr.length) {
            case 64: // lone private key
            case 128: {
                // private key + public key
                const newKey = Ed25519PrivateKey.fromBytes(hex.decode(keyStr));
                newKey._asStringRaw = keyStr;
                return newKey;
            }
            case 96:
                if (keyStr.startsWith(ed25519PrivKeyPrefix)) {
                    const rawStr = keyStr.slice(32);
                    const newKey = Ed25519PrivateKey.fromBytes(hex.decode(rawStr));
                    newKey._asStringRaw = rawStr;
                    return newKey;
                }
                break;
            default:
        }
        throw new BadKeyError();
    }

    /**
     * Recover a key from a 24 or 22-word mnemonic.
     *
     * There is no corresponding `toMnemonic()` as the mnemonic cannot be recovered from the key.
     *
     * Instead, you must generate a mnemonic and a corresponding key in that order with
     * `generateMnemonic()`.
     *
     * This accepts mnemonics generated by the Android and iOS mobile wallets.
     *
     * This key *will* support deriving child keys with `.derive()`.
     *
     * If the mnemonic has 22 words, the resulting key will not support deriving child keys.
     *
     * @param mnemonic the mnemonic, either as a string separated by spaces or as a 24-element array
     * @param passphrase the passphrase to protect the private key with
     *
     * @link generateMnemonic
     */
    public static async fromMnemonic(
        mnemonic: Mnemonic,
        passphrase: string
    ): Promise<Ed25519PrivateKey> {
        if (mnemonic._isLegacy) {
            return mnemonic.toLegacyPrivateKey();
        }

        const input = mnemonic.toString();
        const salt = `mnemonic${passphrase}`;
        const seed = await Pbkdf2.deriveKey(
            HashAlgorithm.Sha512,
            input,
            salt,
            2048,
            64
        );

        const digest = await Hmac.hash(
            HashAlgorithm.Sha512,
            "ed25519 seed",
            seed
        );

        let keyBytes: Uint8Array = digest.subarray(0, 32);
        let chainCode: Uint8Array = digest.subarray(32);

        for (const index of [ 44, 3030, 0, 0 ]) {
            ({ keyBytes, chainCode } = deriveChildKey(
                keyBytes,
                chainCode,
                index
            ));
        }

        const key = Ed25519PrivateKey.fromBytes(keyBytes);
        key._chainCode = chainCode;
        return key;
    }

    /**
     * Recover a private key from a keystore blob previously created by `.createKeystore()`.
     *
     * This key will _not_ support child key derivation.
     *
     * @param keystore the keystore blob
     * @param passphrase the passphrase used to create the keystore
     * @throws KeyMismatchError if the passphrase is incorrect or the hash fails to validate
     * @link createKeystore
     */
    public static async fromKeystore(
        keystore: Uint8Array,
        passphrase: string
    ): Promise<Ed25519PrivateKey> {
        return new Ed25519PrivateKey(await loadKeystore(keystore, passphrase));
    }

    /**
     * Generate a new, cryptographically random private key.
     *
     * This key will _not_ support child key derivation.
     */
    // eslint-disable-next-line require-await
    public static async generate(): Promise<Ed25519PrivateKey> {
        return this.fromBytes(nacl.randomBytes(32));
    }

    /**
     * Derive a new private key at the given wallet index.
     *
     * Only currently supported for keys created with `fromMnemonic()`; other keys will throw
     * an error.
     *
     * You can check if a key supports derivation with `.supportsDerivation`
     *
     * @deprecated `Ed25519PrivateKey.derive()` is deprecated and will eventually be replaced with the async variant `Ed25519PrivateKey.derive2()`
     */
    public derive(index: number): Ed25519PrivateKey {
        console.warn("`Ed25519PrivateKey.derive()` is deprecated and will eventually be replaced with the async variant `Ed25519PrivateKey.derive2()`");
        if (this._chainCode == null) {
            throw new Error("this Ed25519 private key does not support key derivation");
        }

        const { keyBytes, chainCode } = deriveChildKey(
            this._keyData.subarray(0, 32),
            this._chainCode,
            index
        );

        const key = Ed25519PrivateKey.fromBytes(keyBytes);
        key._chainCode = chainCode;

        return key;
    }

    /**
     * Derive a new private key at the given wallet index.
     *
     * Only currently supported for keys created with `fromMnemonic()`; other keys will throw
     * an error.
     *
     * You can check if a key supports derivation with `.supportsDerivation`
     *
     * Will eventually replace `Ed25519PrivateKey.derive()`
     */
    public async derive2(index: number): Promise<Ed25519PrivateKey> {
        if (this._chainCode == null) {
            throw new Error("this Ed25519 private key does not support key derivation");
        }

        const { keyBytes, chainCode } = await deriveChildKey2(
            this._keyData.subarray(0, 32),
            this._chainCode,
            index
        );

        const key = Ed25519PrivateKey.fromBytes(keyBytes);
        key._chainCode = chainCode;

        return key;
    }

    // public async legacyDerive(index: number): Promise<Ed25519PrivateKey> {
    //     const keyBytes = await legacyDeriveChildKey(
    //         this._keyData.subarray(0, 32),
    //         index,
    //         32
    //     );

    //     const key = Ed25519PrivateKey.fromBytes(keyBytes);

    //     return key;
    // }

    /** Check if this private key supports deriving child keys */
    public get supportsDerivation(): boolean {
        return this._chainCode != null;
    }

    public toBytes(): Uint8Array {
        // copy the bytes so they can't be modified accidentally
        // only copy the private key portion since that's what we're expecting on the other end
        return this._keyData.slice(0, 32);
    }

    public toString(raw = false): string {
        if (this._asStringRaw == null) {
            // only encode the private portion of the private key
            this._asStringRaw = hex.encode(this._keyData.subarray(0, 32), true);
        }

        return (raw ? "" : ed25519PrivKeyPrefix) + this._asStringRaw;
    }

    /**
     * Create a keystore blob with a given passphrase.
     *
     * The key can be recovered later with `fromKeystore()`.
     *
     * Note that this will not retain the ancillary data used for deriving child keys,
     * thus `.derive()` on the restored key will throw even if this instance supports derivation.
     *
     * @link fromKeystore
     */
    public toKeystore(passphrase: string): Promise<Uint8Array> {
        return createKeystore(this._keyData, passphrase);
    }

    /**
     * Recover a private key from a pem string; the private key may be encrypted.
     *
     * This method assumes the .pem file has been converted to a string already.
     *
     * If `passphrase` is not null or empty, this looks for the first `ENCRYPTED PRIVATE KEY`
     * section and uses `passphrase` to decrypt it; otherwise, it looks for the first `PRIVATE KEY`
     * section and decodes that as a DER-encoded Ed25519 private key.
     */
    public static async fromPem(
        pem: string,
        passphrase?: string
    ): Promise<Ed25519PrivateKey> {
        const beginTag = passphrase ? beginEncryptedPkey : beginPrivateKey;
        const endTag = passphrase ? endEncryptedPkey : endPrivateKey;

        const beginIndex = pem.indexOf(beginTag);
        const endIndex = pem.indexOf(endTag);

        if (beginIndex === -1 || endIndex === -1) {
            throw new BadPemFileError();
        }

        const keyEncoded = pem.slice(beginIndex + beginTag.length, endIndex);

        // Base64 library throws a "Base64Coder: incorrect characters for decoding"
        // const key = base64.decode(keyEncoded);
        const key = base64.decode(keyEncoded);

        if (passphrase) {
            let encrypted;

            try {
                encrypted = EncryptedPrivateKeyInfo.parse(key);
            } catch (error) {
                throw new BadKeyError(`failed to parse encrypted private key: ${error.message}`);
            }

            const decrypted = await encrypted.decrypt(passphrase);

            if (decrypted.algId.algIdent !== "1.3.101.112") {
                throw new BadKeyError(`unknown private key algorithm ${decrypted.algId}`);
            }

            const keyData = decodeDer(decrypted.privateKey);

            if ("bytes" in keyData) {
                return Ed25519PrivateKey.fromBytes(keyData.bytes);
            }

            throw new BadKeyError(`expected ASN bytes, got ${JSON.stringify(keyData)}`);
        }

        return Ed25519PrivateKey.fromBytes(key);
    }
}
