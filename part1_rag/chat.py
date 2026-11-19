import pandas as pd
import pydeck as pdk
import streamlit as st
from openai import OpenAI

from rag import TABLES, RAGPipeline


@st.cache_resource(show_spinner="Indexing knowledge base (chunking + embeddings)...")
def get_pipeline():
    client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=st.secrets["OPENROUTER_API_KEY"])
    return RAGPipeline(client,
                       planner_model=st.secrets.get("PLANNER_MODEL", "anthropic/claude-haiku-4.5"),
                       answer_model=st.secrets.get("ANSWER_MODEL", "anthropic/claude-sonnet-4.5"))


rag = get_pipeline()

with st.sidebar:
    st.header("📚 Knowledge base")
    for t, cfg in TABLES.items():
        with st.expander(f"{cfg['file']} ({len(rag.dfs[t])} rows)"):
            st.caption(cfg["desc"])
            st.dataframe(rag.dfs[t], width="stretch", height=220)
    st.markdown(f"**Chunks indexed:** {len(rag.chunks)}  \n**Retrieval:** {rag.index.mode}")
    if rag.index.dense_error:
        st.warning(f"Dense embeddings off: {rag.index.dense_error}")
    st.markdown("**Try:**")
    examples = [
        "Which intersections had the most pedestrian crashes at night?",
        "How many fatal crashes were there per area in 2025?",
        "Tell me about the Spine Road & Lansdowne Road hotspot.",
        "What does it recommend there, and who is the inspector for that area?",
        "How quickly must a traffic signal outage be fixed, and how is risk scored?",
        "Compare the speed limits and pedestrian volumes of Klipfontein Road segments.",
        "What's the rugby score tonight?",
    ]
    for ex in examples:
        if st.button(ex, width="stretch"):
            st.session_state.pending = ex
    if st.button("🗑️ Clear chat", width="stretch"):
        st.session_state.messages = []
        st.rerun()

st.title("🚦 Road Safety Command Centre: Ask the Data")
st.caption("RAG over structured CSV/JSON · query planning → hybrid retrieval → exact aggregation → cited answer → verification")

if "messages" not in st.session_state:
    st.session_state.messages = []


def render_visuals(r):
    """Auto-visuals: bar chart for grouped aggregations, map for any retrieved rows that carry coordinates."""
    agg = r.get("agg")
    if agg and isinstance(agg.get("value"), dict) and agg.get("group_by") and agg["value"]:
        s = pd.Series(agg["value"], name=agg.get("column") or "count").head(15)
        st.bar_chart(s, horizontal=True, height=min(60 + 28 * len(s), 460))
    pts = []
    cited = set(r["answer"].get("citations", []))
    for h in r["hits"]:
        m = h["chunk"].meta
        if m.get("lat") and m.get("lon") and (h["chunk"].id in cited or not cited):
            pts.append({"lat": m["lat"], "lon": m["lon"], "label": m.get("intersection") or m.get("location") or h["chunk"].id})
    if agg and agg.get("table") == "crashes" and agg.get("matched_ids"):
        df = rag.dfs["crashes"]
        sub = df[df.crash_id.isin(agg["matched_ids"])]
        pts += [{"lat": a, "lon": b, "label": c} for a, b, c in zip(sub.lat, sub.lon, sub.location)]
    if pts:
        d = pd.DataFrame(pts)
        st.pydeck_chart(pdk.Deck(
            map_provider="carto", map_style="light",
            initial_view_state=pdk.ViewState(latitude=d.lat.mean(), longitude=d.lon.mean(), zoom=10.3),
            layers=[pdk.Layer("ScatterplotLayer", d, get_position="[lon, lat]", get_radius=180,
                              get_fill_color=[220, 38, 38, 170], pickable=True)],
            tooltip={"text": "{label}"}), height=300)


def render_trace(r):
    v, a = r["verification"], r["answer"]
    badge = "✅ Verified" if v["passed"] and v["has_citations"] else ("ℹ️ No data cited" if a.get("not_found") else "⚠️ Check flagged")
    st.caption(f"{badge} · confidence: **{a.get('confidence', '?')}** · intent: **{r['plan'].get('intent')}**")
    with st.expander("🔍 How this answer was produced"):
        st.markdown("**1. Query transformation (planner LLM)**")
        st.json(r["plan"], expanded=False)
        if r["agg"]:
            st.markdown("**2. Exact aggregation (validated filters on the full table)**")
            st.json(r["agg"], expanded=False)
        st.markdown("**3. Retrieved chunks** (RRF fusion of BM25 + cosine)")
        if r["hits"]:
            cited = set(a.get("citations", []))
            st.dataframe(pd.DataFrame([{"source_id": h["chunk"].id, "cited": "✔" if h["chunk"].id in cited else "",
                                        "rrf": h["rrf"], "bm25": h["bm25"], "cosine": h["cosine"],
                                        "text": h["chunk"].text[:160]} for h in r["hits"]]),
                         width="stretch", hide_index=True)
        st.markdown("**4. Verification**")
        st.json(v, expanded=False)
        if a.get("reasoning_note"):
            st.caption(f"Model note: {a['reasoning_note']}")


def render_assistant(text, r):
    st.markdown(text)
    if r:
        render_visuals(r)
        render_trace(r)


for m in st.session_state.messages:
    with st.chat_message(m["role"]):
        if m["role"] == "assistant":
            render_assistant(m["content"], m.get("trace"))
        else:
            st.markdown(m["content"])

q = st.chat_input("Ask about crashes, hotspots, roads, hazard rules or inspectors...")
q = q or st.session_state.pop("pending", None)
if q:
    st.session_state.messages.append({"role": "user", "content": q})
    with st.chat_message("user"):
        st.markdown(q)
    with st.chat_message("assistant"):
        with st.spinner("Planning → retrieving → answering → verifying..."):
            history = [{"role": m["role"], "content": m["content"]} for m in st.session_state.messages[:-1]]
            try:
                r = rag.ask(q, history)
                text = r["answer"].get("answer_markdown", "")
            except Exception as e:
                r, text = None, f"Error calling the model: {e}"
        render_assistant(text, r)
    st.session_state.messages.append({"role": "assistant", "content": text, "trace": r})
