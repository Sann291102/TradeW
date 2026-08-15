from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.core.auth import require_service_token
from app.main import app
from app.strategy import store as strategy_store

FAKE_ROW = {
    "id": "strat_1",
    "userId": "user_1",
    "name": "15-Min ORB",
    "rules": {"timeframe": "15m", "levels": [], "rules": [], "entry": {}, "riskManagement": {"targets": []}},
    "rawInput": "breakout above high",
    "inputType": "text",
    "status": "active",
    "createdAt": datetime.now(timezone.utc).isoformat(),
    "updatedAt": datetime.now(timezone.utc).isoformat(),
}


@pytest.fixture
def client(monkeypatch):
    async def _noop():
        return None

    monkeypatch.setattr(strategy_store, "init_pool", _noop)
    monkeypatch.setattr(strategy_store, "close_pool", _noop)

    async def fake_create(*args, **kwargs):
        return FAKE_ROW

    async def fake_list(user_id):
        return [FAKE_ROW]

    async def fake_get(user_id, strategy_id):
        return FAKE_ROW if strategy_id == "strat_1" else None

    monkeypatch.setattr(strategy_store, "create_strategy", fake_create)
    monkeypatch.setattr(strategy_store, "list_strategies", fake_list)
    monkeypatch.setattr(strategy_store, "get_strategy", fake_get)

    app.dependency_overrides[require_service_token] = lambda: None
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_parse_endpoint_requires_no_auth_bypass_needed(client):
    resp = client.post("/strategies/parse", json={"text": "breakout above high, long above high"})
    assert resp.status_code == 200
    assert resp.json()["parsed"]["entry"]["long"]


def test_list_strategies(client):
    resp = client.get("/strategies", params={"userId": "user_1"})
    assert resp.status_code == 200
    assert resp.json()[0]["id"] == "strat_1"


def test_get_missing_strategy_404(client):
    resp = client.get("/strategies/nope", params={"userId": "user_1"})
    assert resp.status_code == 404


def test_auth_required_without_override(monkeypatch):
    app.dependency_overrides.clear()

    async def _noop():
        return None

    monkeypatch.setattr(strategy_store, "init_pool", _noop)
    monkeypatch.setattr(strategy_store, "close_pool", _noop)
    with TestClient(app) as c:
        resp = c.get("/strategies", params={"userId": "user_1"})
    assert resp.status_code == 401
