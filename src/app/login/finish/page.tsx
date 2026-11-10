import type { Metadata } from "next";
import { firebasePublicConfig, safeAuthCallbackUrl } from "@/auth/config";
import { EmailLinkFinish } from "@/components/EmailLinkFinish";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign-in" };

export default async function EmailLinkFinishPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.callbackUrl) ? params.callbackUrl[0] : params.callbackUrl;
  const callbackUrl = safeAuthCallbackUrl(raw) ?? "/account";
  const firebase = firebasePublicConfig();
  return (
    <div className="sub">
      <div className="sheet-page site-frame">
        <p className="kicker">Account</p>
        <h1>Finish sign-in</h1>
        {!firebase ? (
          <p className="warn-box">Sign-in is not available yet.</p>
        ) : (
          <>
            <p className="lead">Use the link from your email to open your account.</p>
            <EmailLinkFinish firebase={firebase} callbackUrl={callbackUrl} />
          </>
        )}
      </div>
    </div>
  );
}
