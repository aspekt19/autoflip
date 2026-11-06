import Link from "next/link";

export default function NotFound() {
  return (
    <div className="sub">
      <div className="sheet-page">
        <p className="kicker">404</p>
        <h1>That page is not on Lemonless</h1>
        <p className="lead">The link may be mistyped, or the report is not stored on this server.</p>
        <p className="btn-row">
          <Link className="action" href="/">
            Home
          </Link>
          <Link className="quiet" href="/find">
            Find a car
          </Link>
        </p>
      </div>
    </div>
  );
}
