"use client";

import { getApps, initializeApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import type { FirebasePublicConfig } from "@/auth/config";

const APP_NAME = "lemonless";

export function firebaseAuth(config: FirebasePublicConfig): Auth {
  const existing = getApps().find((app) => app.name === APP_NAME);
  const app = existing ?? initializeApp(config, APP_NAME);
  return getAuth(app);
}
