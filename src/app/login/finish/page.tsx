import type { Metadata } from "next";
import { firebasePublicConfig } from "@/auth/config";
import { EmailLinkFinish } from "@/components/EmailLinkFinish";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Finish sign-in" };

export default function EmailLinkFinishPage() {
  const firebase = firebasePublicConfig();
  return (
    <div className="sub">
      <div className="sheet-page">
        <p className="kicker">Account</p>
        <h1>Finish sign-in</h1>
        {!firebase ? (
          <p className="warn-box">Sign-in is not available yet.</p>
        ) : (
          <>
            <p className="lead">Use the link from your email to open your account.</p>
            <EmailLinkFinish firebase={firebase} />
          </>
        )}
      </div>
    </div>
  );
}
