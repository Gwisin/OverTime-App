import { generateKeyPairSync, sign } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const googleJwk = { ...publicKey.export({ format: "jwk" }), kid: "test-google-key", alg: "RS256", use: "sig" };
export function signedToken(email = "vendor@example.com", claims = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encoded = [
    { alg: "RS256", kid: googleJwk.kid, ...header },
    { iss: "https://accounts.google.com", aud: "google-client-id", sub: email, email,
      email_verified: true, name: email, iat: now, exp: now + 3600, ...claims },
  ].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return encoded + "." + sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url");
}
export function keysResponse(keys = [googleJwk]) {
  return Response.json({ keys }, { headers: { "Cache-Control": "public, max-age=3600" } });
}
