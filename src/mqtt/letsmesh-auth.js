const DEFAULT_TTL_SECONDS = 86400;
const DEFAULT_REFRESH_THRESHOLD_SECONDS = 300;

export class LetsMeshAuthError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'LetsMeshAuthError';
  }
}

function base64url(value) {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Creates and refreshes LetsMesh-format JWTs, signed entirely on-device via
 * the radio's Ed25519 identity key - the private key is never exported or
 * read off the device (see docs/project_plan.spec.md Section 20). Token
 * format is LetsMesh-specific, not a standard JOSE JWT: alg "Ed25519"
 * (not "EdDSA"), and the signature segment is lowercase hex, not base64url.
 */
export class LetsMeshAuth {
  #radioManager;
  #audience;
  #ttlSeconds;
  #owner;
  #email;
  #client;
  #logger;
  #currentToken = null;
  #expiresAt = null;

  constructor({ radioManager, audience = null, ttlSeconds = DEFAULT_TTL_SECONDS, owner = null, email = null, client = null, logger }) {
    this.#radioManager = radioManager;
    this.#audience = audience;
    this.#ttlSeconds = ttlSeconds;
    this.#owner = owner;
    this.#email = email;
    this.#client = client;
    this.#logger = logger;
  }

  /** Epoch seconds the current token expires at, or null if none created yet. */
  getExpiration() {
    return this.#expiresAt;
  }

  /**
   * Signs and returns a brand-new token, unconditionally, replacing any
   * cached one. Requires the radio to be connected (device identity known).
   */
  async createToken() {
    const deviceInfo = this.#radioManager.getDeviceInfo();
    if (!deviceInfo) {
      throw new LetsMeshAuthError('cannot create a LetsMesh token before the radio device identity is known');
    }

    const publicKey = deviceInfo.publicKey.toUpperCase();
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + this.#ttlSeconds;

    const payload = { publicKey, iat, exp };
    if (this.#audience) {
      payload.aud = this.#audience;
    }
    if (this.#owner) {
      payload.owner = this.#owner;
    }
    if (this.#email) {
      payload.email = this.#email;
    }
    if (this.#client) {
      payload.client = this.#client;
    }

    const header = { alg: 'Ed25519', typ: 'JWT' };
    const headerEncoded = base64url(JSON.stringify(header));
    const payloadEncoded = base64url(JSON.stringify(payload));
    const signingInput = `${headerEncoded}.${payloadEncoded}`;
    const signingInputBytes = Buffer.from(signingInput, 'utf8');

    let signature;
    try {
      signature = await this.#radioManager.runCommand((connection) => connection.sign(signingInputBytes));
    } catch (err) {
      throw new LetsMeshAuthError(`on-device JWT signing failed: ${err.message}`, { cause: err });
    }

    const signatureHex = Buffer.from(signature).toString('hex');
    const token = `${signingInput}.${signatureHex}`;

    this.#currentToken = token;
    this.#expiresAt = exp;

    // Never log the token or signature itself - only metadata, per the
    // repository's logging contract.
    this.#logger.info('services.mqtt.letsmesh', 'JWT created using on-device signing', {
      audience: this.#audience,
      expiresAt: new Date(exp * 1000).toISOString()
    });

    return token;
  }

  /**
   * Returns the current token if it's still comfortably valid, or signs a
   * fresh one if it's missing or within `thresholdSeconds` of expiring.
   */
  async refreshIfNeeded({ thresholdSeconds = DEFAULT_REFRESH_THRESHOLD_SECONDS } = {}) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (this.#currentToken && this.#expiresAt && nowSeconds < this.#expiresAt - thresholdSeconds) {
      return this.#currentToken;
    }
    return this.createToken();
  }
}
