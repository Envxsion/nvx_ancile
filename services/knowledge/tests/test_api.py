from fastapi.testclient import TestClient

from ancile_knowledge.main import create_app

client = TestClient(create_app(), raise_server_exceptions=False)
AUTH = {"authorization": "Bearer test-service-token"}


def test_health_is_db_free_and_traced():
    r = client.get("/health", headers={"traceparent": "00-" + "a" * 32 + "-" + "b" * 16 + "-01"})
    assert r.status_code == 200 and r.json()["service"] == "knowledge"
    assert r.headers["x-trace-id"] == "a" * 32


def test_kn_requires_service_token():
    r = client.post("/kn/v1/search", json={"query": "q"})
    assert r.status_code == 401
    body = r.json()["error"]
    assert body["code"] == "auth.service_token_invalid" and body["hint"] and body["trace_id"]


def test_not_implemented_uses_error_shape():
    r = client.post("/kn/v1/transformations/run", json={}, headers=AUTH)
    assert r.status_code == 501
    assert r.json()["error"]["code"] == "knowledge.not_implemented"


def test_validation_errors_are_readable():
    r = client.post("/kn/v1/search", json={"query": ""}, headers=AUTH)
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "request.invalid" and "query" in err["hint"]
