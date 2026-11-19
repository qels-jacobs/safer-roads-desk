import streamlit as st

st.set_page_config(page_title="Safer Roads Desk", page_icon="🚦", layout="wide")

pg = st.navigation([
    st.Page("chat.py", title="Ask the Data (RAG)", icon="💬", default=True),
    st.Page("command_centre.py", title="Live Command Centre", icon="🗺️"),
])
st.sidebar.caption("⚠️ Demo project. Synthetic data on real Cape Town street names. "
                   "Not affiliated with the City of Cape Town or the Western Cape Government.")
pg.run()
