"""FastAPI example: expose a memory-backed assistant endpoint.

The API key stays on the server. The browser never sees it, and the tenant
identity is resolved by the host, never accepted from the request body.

Install:  pip install fastapi uvicorn
Run:      uvicorn examples.fastapi.app:app --reload
"""

from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from remembra import ApiError, Remembra

app = FastAPI(title="Remembra assistant")
# One shared client: the key lives in the environment, never in a request.
client = Remembra(
    os.environ.get("REMEMBRA_ENDPOINT", "http://127.0.0.1:8787"),
    api_key=os.environ.get("REMEMBRA_API_KEY"),
)


class Ask(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    remember: str | None = Field(default=None, max_length=2_000)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/ask")
def ask(request: Ask) -> dict:
    try:
        context = client.context({"query": request.question, "maxTokens": 1_500, "limit": 8})
    except ApiError as error:
        # Surface a stable code, never a provider secret or raw diagnostic.
        raise HTTPException(status_code=error.status, detail={"code": error.code}) from error
    if request.remember:
        client.store({"type": "fact", "content": request.remember, "importance": 6})
    return {
        "answer_context": context["context"],
        "token_count": context["tokenCount"],
        "sources": [memory["id"] for memory in context.get("memories", [])],
    }
