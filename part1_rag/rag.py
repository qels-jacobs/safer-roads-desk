"""
Safer Roads Desk - Road Safety Command Centre - RAG core.

Pipeline:  question -> query transformation (LLM -> JSON plan)
                     -> hybrid retrieval (BM25 + dense embeddings, RRF fusion, table filter)
                     -> optional structured aggregation (pandas, validated filters - no code exec)
                     -> grounded answer (LLM -> JSON with citations)
                     -> verification (citations exist, numbers appear in context)
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
from rank_bm25 import BM25Okapi

DATA_DIR = Path(__file__).parent / "data"

# Table registry: the key column gives every row a stable, citable ID.
TABLES = {
    "crashes": {"file": "crashes.csv", "key": "crash_id",
                "desc": "Individual road crashes Jul 2023 - Oct 2026: date, time, area, suburb, location/intersection, hotspot, crash type, severity, light, weather, casualties, contributing factor."},
    "hotspots": {"file": "hotspots.csv", "key": "hotspot_id",
                 "desc": "High-risk intersections: crash counts (3 years), fatal, serious, pedestrian crashes, night share, risk rank, recommended intervention."},
    "road_register": {"file": "road_register.csv", "key": "road_id",
                      "desc": "Road segments: name, area, suburbs, road class, speed limit, lanes, pedestrian volume, jurisdiction (municipal or national)."},
    "hazard_rules": {"file": "hazard_response_rules.json", "key": "hazard_code", "json_list": "hazard_types",
                     "desc": "Hazard response rules: severity (1-5), repair deadline in hours, responsible department, whether inspection is required."},
    "inspectors": {"file": "inspectors.csv", "key": "inspector_id",
                   "desc": "Road inspectors per area: name, area, suburbs covered, contact, shift."},
}
DOMAIN = "Safer Roads Desk, a fictional Cape Town road-safety unit (synthetic data on real street names)"


@dataclass
class Chunk:
    id: str            # e.g. incident_log#INC-0042  (traceable to file + row)
    table: str
    text: str
    kind: str = "row"  # row | summary
    meta: dict = field(default_factory=dict)


# ---------------------------------------------------------------- ingestion
def load_tables() -> dict[str, pd.DataFrame]:
    dfs = {}
    for name, cfg in TABLES.items():
        p = DATA_DIR / cfg["file"]
        if p.suffix == ".json":
            dfs[name] = pd.DataFrame(json.loads(p.read_text())[cfg["json_list"]])
        else:
            dfs[name] = pd.read_csv(p)
    return dfs


def row_to_text(table: str, row: pd.Series) -> str:
    """Serialise one row as 'column: value' pairs, so the header travels with every value."""
    pairs = "; ".join(f"{c.replace('_', ' ')}: {v}" for c, v in row.items() if pd.notna(v))
    return f"[{table.replace('_', ' ')}] {pairs}"


def table_summary(table: str, df: pd.DataFrame) -> str:
    parts = [f"[{table.replace('_', ' ')} - table summary] {TABLES[table]['desc']} Rows: {len(df)}."]
    for c in df.columns:
        if pd.api.types.is_numeric_dtype(df[c]):
            parts.append(f"{c}: range {df[c].min()}-{df[c].max()}")
        elif df[c].nunique() <= 15:
            parts.append(f"{c} values: {', '.join(map(str, sorted(df[c].dropna().unique())))}")
    return " ".join(parts)


def build_chunks(dfs: dict[str, pd.DataFrame]) -> list[Chunk]:
    """Chunking strategy for structured data: one chunk per row (atomic, citable) + one summary chunk per table.
    Rows are small, so splitting by token count would only break records apart."""
    chunks = []
    for t, df in dfs.items():
        key = TABLES[t]["key"]
        for _, r in df.iterrows():
            chunks.append(Chunk(f"{t}#{r[key]}", t, row_to_text(t, r), meta=r.to_dict()))
        chunks.append(Chunk(f"{t}#SUMMARY", t, table_summary(t, df), kind="summary"))
    rules = json.loads((DATA_DIR / TABLES["hazard_rules"]["file"]).read_text())
    rs = rules["risk_score"]
    chunks.append(Chunk("hazard_rules#RISK_SCORE", "hazard_rules",
                        "[hazard rules - risk score and priority method] " + json.dumps(rs), kind="summary"))
    return chunks


# ---------------------------------------------------------------- retrieval
STOP = set("a an and are at by for from how in is it of on or the to was were what which who with".split())


def _tok(s: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+(?:-[a-z0-9]+)*", s.lower()) if t not in STOP]


class HybridIndex:
    """BM25 (exact IDs, codes, road names) + dense vectors (meaning), fused with Reciprocal Rank Fusion.

    Dense vectors: LSA embeddings by default (TF-IDF with word n-grams + truncated SVD to 128 dims). They are
    built in-process at start-up, with no model download, so the app starts in seconds on a small free host.
    Set EMBEDDINGS=fastembed (secret/env) to use the BAAI/bge-small-en-v1.5 neural model instead.
    """

    def __init__(self, chunks: list[Chunk], backend: str = "lsa", embed_model: str = "BAAI/bge-small-en-v1.5"):
        self.chunks = chunks
        self.bm25 = BM25Okapi([_tok(c.text) for c in chunks])
        self.embedder, self.vecs, self.dense_error, self.backend = None, None, None, backend
        texts = [c.text for c in chunks]
        try:
            if backend == "fastembed":
                from fastembed import TextEmbedding
                self.embedder = TextEmbedding(embed_model)
                self.vecs = self._embed(texts)
            else:
                from sklearn.decomposition import TruncatedSVD
                from sklearn.feature_extraction.text import TfidfVectorizer
                self._tfidf = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, min_df=1)
                X = self._tfidf.fit_transform(texts)
                self._svd = TruncatedSVD(n_components=min(128, X.shape[1] - 1), random_state=0)
                self.vecs = self._norm(self._svd.fit_transform(X))
        except Exception as e:  # app still works on keyword search, and says so in the UI
            self.dense_error = str(e)[:200]

    @staticmethod
    def _norm(v):
        return v / np.clip(np.linalg.norm(v, axis=1, keepdims=True), 1e-9, None)

    @property
    def mode(self) -> str:
        if self.vecs is None:
            return "BM25 only (vector index unavailable)"
        return "hybrid: BM25 + vectors (" + ("bge-small neural embeddings" if self.backend == "fastembed" else "LSA embeddings") + ")"

    def _embed(self, texts):
        if self.backend == "fastembed":
            return self._norm(np.array(list(self.embedder.embed(texts))))
        return self._norm(self._svd.transform(self._tfidf.transform(texts)))

    def search(self, query: str, k: int = 8, tables: list[str] | None = None, rrf_k: int = 60):
        allowed = [i for i, c in enumerate(self.chunks) if not tables or c.table in tables]
        if not allowed:
            allowed = list(range(len(self.chunks)))
        bm = self.bm25.get_scores(_tok(query))
        rankings = [sorted(allowed, key=lambda i: -bm[i])]
        dense = None
        if self.vecs is not None:
            dense = self.vecs @ self._embed([query])[0]
            rankings.append(sorted(allowed, key=lambda i: -dense[i]))
        fused = {}
        for ranking in rankings:
            for rank, i in enumerate(ranking):
                fused[i] = fused.get(i, 0) + 1 / (rrf_k + rank + 1)
        top = sorted(fused, key=lambda i: -fused[i])[:k]
        return [{"chunk": self.chunks[i], "rrf": round(fused[i], 4), "bm25": round(float(bm[i]), 2),
                 "cosine": None if dense is None else round(float(dense[i]), 3)} for i in top]


# ---------------------------------------------------------------- structured aggregation tool
OPS = {"eq", "neq", "contains", "gt", "gte", "lt", "lte", "between"}
AGGS = {"count", "sum", "mean", "max", "min", "list"}


def run_aggregation(dfs, spec: dict) -> dict:
    """Execute an LLM-proposed aggregation. Every table/column/op is validated against the schema,
    so the model can only *describe* a query - it never runs code."""
    t = spec.get("table")
    if t not in dfs:
        return {"error": f"unknown table {t}"}
    df = dfs[t].copy()
    applied = []
    for f in spec.get("filters", []) or []:
        c, op, v = f.get("column"), f.get("op"), f.get("value")
        if c not in df.columns or op not in OPS:
            applied.append(f"SKIPPED invalid filter {f}")
            continue
        s = df[c]
        if c.endswith("date"):
            s = pd.to_datetime(s, errors="coerce")
            v = pd.to_datetime(v) if op != "between" else [pd.to_datetime(x) for x in v]
        if op == "eq":
            m = s.astype(str).str.lower() == str(v).lower()
        elif op == "neq":
            m = s.astype(str).str.lower() != str(v).lower()
        elif op == "contains":
            m = s.astype(str).str.contains(str(v), case=False, regex=False)
        elif op == "between":
            m = (s >= v[0]) & (s <= v[1])
        else:
            m = {"gt": s > v, "gte": s >= v, "lt": s < v, "lte": s <= v}[op]
        df = df[m.fillna(False)]
        applied.append(f"{c} {op} {f.get('value')}")
    agg, col, gb = spec.get("agg", "count"), spec.get("column"), spec.get("group_by")
    if agg not in AGGS:
        agg = "count"
    if col is not None and col not in df.columns:
        col = None
    if gb is not None and gb not in df.columns:
        gb = None
    key = TABLES[t]["key"]
    res = {"table": t, "filters_applied": applied, "agg": agg, "column": col, "group_by": gb,
           "matched_rows": int(len(df)), "matched_ids": df[key].astype(str).tolist()[:50]}
    if agg == "count":
        res["value"] = df.groupby(gb).size().sort_values(ascending=False).to_dict() if gb else int(len(df))
    elif agg == "list":
        res["value"] = df.head(25).to_dict(orient="records")
    elif col and pd.api.types.is_numeric_dtype(df[col]):
        res["value"] = (df.groupby(gb)[col].agg(agg).round(2).sort_values(ascending=False).to_dict() if gb
                        else round(float(getattr(df[col], agg)()), 2) if len(df) else None)
    else:
        res["value"] = None
        res["error"] = "aggregation needs a numeric column"
    return res


# ---------------------------------------------------------------- LLM steps
def schema_text(dfs) -> str:
    lines = []
    for t, df in dfs.items():
        cols = ", ".join(f"{c}({'num' if pd.api.types.is_numeric_dtype(df[c]) else 'text'})" for c in df.columns)
        lines.append(f"- {t}: {TABLES[t]['desc']} Columns: {cols}")
    return "\n".join(lines)


REWRITE_PROMPT = """You are the query planner for {domain}.
Turn the user's latest message into a JSON plan. Use the conversation history to resolve
pronouns and follow-ups ("what about its speed?") into a standalone query.

Tables:
{schema}

Categorical values worth knowing:
{values}

Return ONLY JSON:
{{
 "standalone_query": "self-contained rewrite of the question",
 "intent": "lookup | aggregate | compare | policy | out_of_scope",
 "tables": ["table names most likely to hold the answer"],
 "search_queries": ["1-3 keyword-rich search strings (include IDs, classes, corridor names)"],
 "aggregation": null or {{"table": "...", "filters": [{{"column": "...", "op": "eq|neq|contains|gt|gte|lt|lte|between", "value": ...}}],
                         "agg": "count|sum|mean|max|min|list", "column": "numeric column or null", "group_by": "column or null"}},
 "answer_format": "short | table | list"
}}
Use "aggregate" whenever the question needs counting, totals, averages, rankings or filtering many rows
(retrieval alone cannot count reliably). Dates are ISO (YYYY-MM-DD); for a year use between.
Counting questions that combine conditions (crash type, severity, time of day, weather, date range, area) MUST aggregate
the crashes table: e.g. "pedestrian crashes at night by intersection" = table crashes, filters crash_type eq Pedestrian and
light_condition contains "Dark", agg count, group_by location. Never derive such counts from hotspot percentages.
Use the hotspots table for hotspot attributes (rank, recommended intervention, 3-year totals).
Use "out_of_scope" if the question is unrelated to this road-safety data."""

ANSWER_PROMPT = """You answer questions for {domain} using ONLY the context below.
Rules:
- Every factual statement must be supported by a source ID in square brackets, e.g. [incident_log#INC-0042].
- If an [AGG] result is present, it is computed exactly from the full table and is THE answer to any count/total/
  ranking question: report its numbers exactly (never estimate, approximate or derive counts from percentages),
  rank by them, and cite [AGG]. Use row chunks only to add descriptive context.
- If the context does not contain the answer, say so plainly and set "not_found": true. Never guess.
- Format the answer as: {fmt}. Use a markdown table when comparing several items.

Return ONLY JSON:
{{"answer_markdown": "...", "citations": ["source ids used"], "confidence": "high|medium|low",
  "not_found": false, "reasoning_note": "one sentence on how the context supports the answer"}}

CONTEXT:
{context}"""


def parse_json(s: str) -> dict:
    m = re.search(r"\{.*\}", s, re.S)
    if not m:
        raise ValueError("no JSON in model output")
    return json.loads(m.group(0))


def categorical_values(dfs) -> str:
    out = []
    for t, df in dfs.items():
        for c in df.columns:
            if df[c].dtype == object and 1 < df[c].nunique() <= 15:
                out.append(f"{t}.{c}: {', '.join(map(str, sorted(df[c].dropna().unique())))}")
    return "\n".join(out)


class RAGPipeline:
    def __init__(self, llm, planner_model: str, answer_model: str, embeddings: str = "lsa"):
        """llm: an OpenAI-compatible client (OpenRouter)."""
        self.llm, self.planner_model, self.answer_model = llm, planner_model, answer_model
        self.dfs = load_tables()
        self.chunks = build_chunks(self.dfs)
        self.index = HybridIndex(self.chunks, backend=embeddings)

    def _chat(self, model, system, messages, max_tokens=1200):
        r = self.llm.chat.completions.create(model=model, max_tokens=max_tokens, temperature=0,
                                             messages=[{"role": "system", "content": system}] + messages)
        return r.choices[0].message.content

    def plan(self, question: str, history: list[dict]) -> dict:
        hist = "\n".join(f"{m['role']}: {m['content'][:400]}" for m in history[-6:])
        sys = REWRITE_PROMPT.format(domain=DOMAIN, schema=schema_text(self.dfs), values=categorical_values(self.dfs))
        raw = self._chat(self.planner_model, sys, [{"role": "user", "content": f"History:\n{hist or '(none)'}\n\nLatest message: {question}"}], 800)
        try:
            p = parse_json(raw)
        except Exception:
            p = {"standalone_query": question, "intent": "lookup", "tables": [], "search_queries": [question]}
        p["tables"] = [t for t in p.get("tables", []) if t in TABLES]
        return p

    def retrieve(self, plan: dict, k: int = 8):
        seen, hits = set(), []
        for q in [plan.get("standalone_query", "")] + plan.get("search_queries", []):
            for h in self.index.search(q, k=k, tables=plan.get("tables") or None):
                if h["chunk"].id not in seen:
                    seen.add(h["chunk"].id)
                    hits.append(h)
        return sorted(hits, key=lambda h: -h["rrf"])[:k + 4]

    @staticmethod
    def verify(answer: dict, hits, agg) -> dict:
        """Traceability checks: citations must point at retrieved chunks, numbers must appear in the context."""
        valid = {h["chunk"].id for h in hits} | ({"AGG"} if agg else set())
        cites = answer.get("citations", [])
        text = answer.get("answer_markdown", "")
        inline = set(re.findall(r"\[([a-z_]+#[A-Za-z0-9_\-]+|AGG)\]", text))
        bad = sorted((set(cites) | inline) - valid)
        context_blob = " ".join(h["chunk"].text for h in hits) + json.dumps(agg or {}, default=str)
        ctx_nums = set(re.findall(r"\d+(?:\.\d+)?", context_blob))
        nums = [n for n in re.findall(r"(?<![#\w-])\d+(?:\.\d+)?", re.sub(r"\[[^\]]*\]", "", text))]
        ungrounded = sorted({n for n in nums if n not in ctx_nums and len(n) > 1})
        return {"invalid_citations": bad, "ungrounded_numbers": ungrounded,
                "passed": not bad and not ungrounded, "has_citations": bool(cites or inline)}

    def ask(self, question: str, history: list[dict]) -> dict:
        plan = self.plan(question, history)
        if plan.get("intent") == "out_of_scope":
            return {"plan": plan, "hits": [], "agg": None,
                    "answer": {"answer_markdown": "That question is outside the Safer Roads Desk knowledge base "
                               "(crashes, hotspots, road register, hazard rules, inspectors).",
                               "citations": [], "confidence": "high", "not_found": True},
                    "verification": {"passed": True, "invalid_citations": [], "ungrounded_numbers": [], "has_citations": False}}
        hits = self.retrieve(plan)
        agg = run_aggregation(self.dfs, plan["aggregation"]) if plan.get("aggregation") else None
        ctx = "\n".join(f"[{h['chunk'].id}] {h['chunk'].text}" for h in hits)
        if agg:
            ctx += f"\n[AGG] Exact computed result over the full table: {json.dumps(agg, default=str)}"
        sys = ANSWER_PROMPT.format(domain=DOMAIN, fmt=plan.get("answer_format", "short"), context=ctx)
        msgs = history[-4:] + [{"role": "user", "content": plan.get("standalone_query", question)}]
        raw = self._chat(self.answer_model, sys, msgs, 1500)
        try:
            ans = parse_json(raw)
        except Exception:
            ans = {"answer_markdown": raw, "citations": [], "confidence": "low", "not_found": False}
        return {"plan": plan, "hits": hits, "agg": agg, "answer": ans, "verification": self.verify(ans, hits, agg)}
