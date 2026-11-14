import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    emailVerified?: Date | null;
  }

  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      emailVerified?: Date | null;
      isAdmin?: boolean;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    emailVerified?: string | null;
  }
}
