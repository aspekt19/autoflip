import { SearchPanel } from "@/components/SearchPanel";

export default function HomePage() {
  return (
    <div className="wrap hero">
      <div className="grid-2">
        <div>
          <h1>Should you buy this car, or walk away?</h1>
          <p className="lede">
            Paste a listing or scan a make and model. AutoFlip scores the asking price against comparable listings, mileage, history flags, recalls, and fuel cost — then says good deal, fair, overpriced, or walk away.
          </p>
          <div style={{ marginTop: 22 }}>
            <SearchPanel />
          </div>
        </div>
        <aside className="card side-note">
          <h2>Two questions, one set of numbers</h2>
          <p>
            <strong>Drive it</strong> asks whether the price makes sense for a car you will keep.
          </p>
          <p>
            <strong>Flip it</strong> asks whether a resale still leaves a margin after fee and reconditioning assumptions.
          </p>
          <ol className="steps">
            <li>Deal Radar is free and stays inside one search.</li>
            <li>A full report costs 1 credit and adds recalls, complaints, and fuel.</li>
            <li>Every dollar in the verdict is computed in code. The paragraph only explains it.</li>
          </ol>
        </aside>
      </div>
    </div>
  );
}
