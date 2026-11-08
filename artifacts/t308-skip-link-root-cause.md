# Skip-to-content invisible while focused — root cause

**Before fix (06f8bad):**

1. `.skip` used `position: absolute; top: -48px` and only `.skip:focus { top: 12px }`.
2. `body { overflow-x: hidden }` — in Chromium this creates a scroll containment that **clips** off-screen absolute children; focus reveal can fail to paint.
3. Sticky `.bar` and `.skip` both used `z-index: 40`; `.bar` comes later in DOM so it **covers** the focused skip link at `top: 12px`.

**Fix:** `position: fixed; z-index: 100; transform: translateY(-160%)` resting; `:focus` / `:focus-visible` → `translateY(0)` with outline.
