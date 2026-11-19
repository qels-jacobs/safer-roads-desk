"""Live Command Centre: crash heatmap + hotspots (Part 1 data) + hazard cases written by the n8n agent (Part 2)."""
from pathlib import Path

import pandas as pd
import pydeck as pdk
import streamlit as st

DATA = Path(__file__).parent / "data"
# Published (read-only) CSV of the agent's Google Sheet - synthetic demo cases only.
DEFAULT_CASES_URL = ("https://docs.google.com/spreadsheets/d/e/2PACX-1vT3g0wLEpL3dGBp8odBp42FSj8L3n8k6WSu16m3MT0N2oWLaoKBgSqZl8"
                     "-1bSsl7RIw4mnqnlxYBywe/pub?gid=1042111303&single=true&output=csv")
PRIORITY_COLOUR = {"P1": [220, 38, 38], "P2": [245, 158, 11], "P3": [37, 99, 235], "REFERRED": [107, 114, 128], "INCOMPLETE": [168, 85, 247]}


@st.cache_data
def base_layers():
    return pd.read_csv(DATA / "crashes.csv"), pd.read_csv(DATA / "hotspots.csv")


@st.cache_data(ttl=20, show_spinner=False)
def load_cases(url: str | None):
    """Returns (cases, mode, note). No Streamlit UI calls in here: cached functions must stay side-effect free."""
    if url:
        try:
            import time
            fresh = url + ("&" if "?" in url else "?") + f"cb={int(time.time())}"  # bypass Google's publish cache
            df = pd.read_csv(fresh)
            if len(df):
                return df, "live", ""
            # Live sheet connected but empty: show an honest empty state, not sample data.
            return pd.read_csv(DATA / "demo_cases.csv").iloc[0:0], "empty", ""
        except Exception as e:
            note = f"Could not read the live sheet ({type(e).__name__})."
    else:
        note = ""
    return pd.read_csv(DATA / "demo_cases.csv"), "sample", note


crashes, hotspots = base_layers()
st.title("🗺️ Live Command Centre")
st.caption("Crash heatmap and hotspots come from the Part 1 knowledge base. Hazard cases are written by the Part 2 n8n agent, "
           "which uses the same crash data to prioritise repairs.")


@st.fragment(run_every="30s")
def live_view():
    url = st.secrets.get("CASES_CSV_URL", DEFAULT_CASES_URL)
    cases, mode, note = load_cases(url)
    cases["band"] = cases["priority"].astype(str).str.split(" ").str[0]
    top = st.columns([4, 1])
    top[0].caption({"live": "🟢 Live from the agent's Google Sheet",
                    "empty": "🟢 Connected to the agent's Google Sheet: no cases yet. Waiting for the agent to run",
                    }.get(mode, f"🟡 Showing sample cases. {note}") + " · refreshes every 30 s")
    if top[1].button("🔄 Refresh now", width="stretch"):
        load_cases.clear()
        st.rerun()

    k = st.columns(5)
    k[0].metric("Open cases", len(cases))
    k[1].metric("🔴 P1 urgent", int((cases.band == "P1").sum()))
    k[2].metric("Inspections booked", int(cases.get("inspection_start", pd.Series(dtype=str)).fillna("").astype(str).str.len().gt(0).sum()))
    k[3].metric("Duplicate reports merged", int(pd.to_numeric(cases.get("reports"), errors="coerce").fillna(1).sum() - len(cases)))
    k[4].metric("Referred to SANRAL", int((cases.band == "REFERRED").sum()))

    areas = ["All"] + sorted(cases["area"].dropna().unique().tolist())
    area = st.segmented_control("Area", areas, default="All")
    view = cases if area in (None, "All") else cases[cases.area == area]

    geo = view.dropna(subset=["lat", "lon"]).copy()
    geo["colour"] = geo.band.map(PRIORITY_COLOUR).apply(lambda c: c if isinstance(c, list) else [100, 100, 100])
    geo["radius"] = 120 + 90 * pd.to_numeric(geo.get("reports"), errors="coerce").fillna(1)
    geo["tip"] = ("<b>" + geo.case_id.astype(str) + " · " + geo.priority.astype(str) + "</b><br/>" + geo.hazard_label.astype(str)
                  + "<br/>" + geo.location_text.astype(str) + "<br/>score " + geo.risk_score.astype(str) + " · reports "
                  + geo.reports.astype(str) + "<br/>" + geo.inspector.fillna("").astype(str) + " " + geo.inspection_start.fillna("").astype(str))
    hs = hotspots.assign(tip="<b>Hotspot " + hotspots.hotspot_id + "</b><br/>" + hotspots.intersection + "<br/>" + hotspots.crashes_3yr.astype(str)
                         + " crashes (" + hotspots.fatal.astype(str) + " fatal) · rank " + hotspots.risk_rank.astype(str))
    crash_w = crashes.assign(w=crashes.severity.map({"Fatal": 6, "Serious": 3, "Slight": 1, "Damage only": 0.5}))
    layers = [
        pdk.Layer("HeatmapLayer", crash_w, get_position="[lon, lat]", get_weight="w", radius_pixels=45, opacity=0.45),
        pdk.Layer("ScatterplotLayer", hs, get_position="[lon, lat]", get_radius=260, stroked=True, filled=False,
                  get_line_color=[17, 24, 39], line_width_min_pixels=2, pickable=True),
        pdk.Layer("ScatterplotLayer", geo, get_position="[lon, lat]", get_radius="radius", get_fill_color="colour",
                  get_line_color=[255, 255, 255], stroked=True, line_width_min_pixels=1, pickable=True),
    ]
    st.pydeck_chart(pdk.Deck(
        map_provider="carto", map_style="light", layers=layers,
        initial_view_state=pdk.ViewState(latitude=-33.97, longitude=18.55, zoom=10.2),
        tooltip={"html": "{tip}"}),
        height=520)
    st.caption("🔴 P1 urgent · 🟠 P2 high · 🔵 P3 routine · ⚫ referred to SANRAL · 🟣 incomplete · black rings = crash hotspots · "
               "heat = crash severity · bigger dot = more reports")

    st.subheader("Cases by priority")
    cols = [c for c in ["case_id", "priority", "risk_score", "hazard_label", "location_text", "area", "reports", "hotspot_id",
                        "inspector", "inspection_start", "flags", "score_breakdown"] if c in view.columns]
    st.dataframe(view.sort_values("risk_score", ascending=False)[cols], width="stretch", hide_index=True)
    if len(view):
        st.bar_chart(view.groupby(["area", "band"]).size().unstack(fill_value=0), height=260)


live_view()
