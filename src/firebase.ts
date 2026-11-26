/**
 * Firebase app + App Check initialization.
 *
 * Config comes from Vite env vars (see .env.example). The Firebase web config
 * is not a secret, but it lives in .env (gitignored) so each environment —
 * local dev, the hackathon demo deploy — carries its own project's values.
 *
 * App Check: when a reCAPTCHA Enterprise site key is present, App Check is
 * initialized with the ReCaptchaEnterpriseProvider (Firebase's Fraud Defense
 * provider — the Classic reCAPTCHA v3 provider is deprecated) and AI Logic
 * calls are attested. On localhost we enable the App Check debug token flow
 * instead: the debug token printed in the browser console must be
 * safelisted once in the Firebase console (App Check > Apps > Manage debug
 * tokens).
 */
import { initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "",
};

/** True when .env carries a real Firebase project config. */
export const firebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId,
);

export const firebaseApp: FirebaseApp | undefined = firebaseConfigured
  ? initializeApp(firebaseConfig)
  : undefined;

const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY ?? "";

export const appCheckConfigured = Boolean(firebaseApp && recaptchaSiteKey);

if (firebaseApp && recaptchaSiteKey) {
  if (window.location.hostname === "localhost") {
    // Debug provider for local development: prints a debug token to the
    // console, which gets safelisted once in the Firebase console.
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      true;
  }
  initializeAppCheck(firebaseApp, {
    provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
}
