"""Authentication module for Gmail MCP server.

Supports two storage backends, selected automatically:
- Environment variable (GOOGLE_MCP_TOKEN): for Azure/Linux deployments
  where secrets are injected by Key Vault
- macOS Keychain (keyring): for local macOS development
"""

import json
import os

import httplib2
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_httplib2 import AuthorizedHttp
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from .config import GOOGLE_TOKEN_ENV, KEYCHAIN_SERVICE, get_credentials_path
from .logging_setup import log

# Socket-level timeout (seconds) for every Gmail API HTTP request. This is
# the underlying httplib2 transport timeout — defense in depth below the
# asyncio per-call timeout in `_async.run_blocking`. Without it, httplib2
# defaults to no timeout and a stalled Google response will hang the worker
# thread forever.
HTTP_SOCKET_TIMEOUT_S = 30


def _build_service(creds: Credentials):
    """Build a Gmail API service with a socket-level timeout on the transport.

    The default `build("gmail", "v1", credentials=creds)` constructs an
    httplib2 client with **no** timeout. We replace it with an
    `AuthorizedHttp` that wraps `httplib2.Http(timeout=...)` so a single
    hung Google API call cannot block forever.

    `cache_discovery=False` avoids googleapiclient writing a discovery cache
    to disk (it warns otherwise on systems without `oauth2client`).
    """
    http = AuthorizedHttp(creds, http=httplib2.Http(timeout=HTTP_SOCKET_TIMEOUT_S))
    return build("gmail", "v1", http=http, cache_discovery=False)

# Gmail API scopes
# - gmail.modify: read, write, and modify emails (includes archive)
# - gmail.send: send emails (used for integration tests)
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
]


# --- Backend selection ---


def _use_env_backend() -> bool:
    """Check if the env var backend should be used."""
    return os.environ.get(GOOGLE_TOKEN_ENV) is not None


# --- Environment variable backend ---

_cached_creds: Credentials | None = None


def _env_is_authenticated() -> bool:
    global _cached_creds
    if _cached_creds is not None:
        return True
    try:
        _env_load_credentials()
    except Exception:
        return False
    return _cached_creds is not None


def _env_get_token() -> Credentials | None:
    global _cached_creds
    if _cached_creds is None:
        _env_load_credentials()
    if _cached_creds and _cached_creds.expired and _cached_creds.refresh_token:
        _refresh_credentials(_cached_creds, source="env")
    return _cached_creds


def _env_load_credentials() -> None:
    """Parse credentials from env var into memory."""
    global _cached_creds
    token_json = os.environ.get(GOOGLE_TOKEN_ENV)
    if not token_json:
        return
    token_info = json.loads(token_json)
    _cached_creds = Credentials.from_authorized_user_info(token_info, SCOPES)


# --- Keychain backend ---


def _keychain_is_authenticated() -> bool:
    import keyring

    token_data = keyring.get_password(KEYCHAIN_SERVICE, "token")
    return token_data is not None


def _keychain_get_token() -> Credentials | None:
    import keyring

    token_data = keyring.get_password(KEYCHAIN_SERVICE, "token")
    if not token_data:
        return None

    try:
        token_info = json.loads(token_data)
        creds = Credentials.from_authorized_user_info(token_info, SCOPES)
        return creds
    except (json.JSONDecodeError, ValueError):
        return None


def _keychain_store_token(creds: Credentials) -> None:
    import keyring

    token_data = creds.to_json()
    keyring.set_password(KEYCHAIN_SERVICE, "token", token_data)


# --- Public API ---


def is_authenticated() -> bool:
    """Check if valid credentials are available.

    Returns:
        True if authenticated, False otherwise
    """
    if _use_env_backend():
        return _env_is_authenticated()
    return _keychain_is_authenticated()


def get_token() -> Credentials | None:
    """Retrieve Google OAuth credentials.

    Returns:
        Credentials object if found and valid, None otherwise
    """
    if _use_env_backend():
        return _env_get_token()
    return _keychain_get_token()


def store_token(creds: Credentials) -> None:
    """Save credentials to the active backend.

    Args:
        creds: Google OAuth credentials to store
    """
    if _use_env_backend():
        return  # env var is read-only; token seeded externally
    _keychain_store_token(creds)


def _has_required_scopes(creds: Credentials) -> bool:
    """Check if credentials have all required scopes.

    Args:
        creds: Google OAuth credentials

    Returns:
        True if all required scopes are present, False otherwise
    """
    if not creds.scopes:
        return False
    return all(scope in creds.scopes for scope in SCOPES)


def _refresh_credentials(creds: Credentials, *, source: str) -> bool:
    """Refresh OAuth credentials in place, logging timing and outcome.

    Returns True on success, False on any exception. The caller decides
    whether a failure should fall back to re-auth or surface as an error.
    """
    import time

    start = time.monotonic()
    try:
        creds.refresh(Request())
    except Exception as exc:
        log(
            "error",
            "auth_refresh",
            source=source,
            ok=False,
            elapsed_ms=int((time.monotonic() - start) * 1000),
            exc_type=type(exc).__name__,
            msg=str(exc),
        )
        return False
    log(
        "info",
        "auth_refresh",
        source=source,
        ok=True,
        elapsed_ms=int((time.monotonic() - start) * 1000),
    )
    return True


def run_oauth_flow() -> str:
    """Run OAuth flow to authenticate with Gmail.

    If already authenticated with a valid token and correct scopes, returns
    the email without opening browser. If scopes are missing, forces
    re-authentication. Otherwise, opens browser for user to grant access.

    Returns:
        The authenticated user's email address

    Raises:
        FileNotFoundError: If credentials.json is missing
    """
    # Check if we already have valid credentials with correct scopes
    creds = get_token()
    if creds and creds.valid and _has_required_scopes(creds):
        # Already authenticated with correct scopes - just get the email
        service = _build_service(creds)
        profile = service.users().getProfile(userId="me").execute()
        return profile.get("emailAddress", "unknown")

    # Try to refresh expired token (only if scopes are correct)
    if creds and creds.expired and creds.refresh_token and _has_required_scopes(creds):
        if _refresh_credentials(creds, source="oauth_flow"):
            store_token(creds)
            service = _build_service(creds)
            profile = service.users().getProfile(userId="me").execute()
            return profile.get("emailAddress", "unknown")
        # Refresh failed, fall through to re-authenticate

    # Need to run OAuth flow (either no token, invalid, or missing scopes)
    credentials_path = get_credentials_path()

    if not credentials_path.exists():
        raise FileNotFoundError(
            f"credentials.json not found at {credentials_path}\n"
            "Please download OAuth credentials from Google Cloud Console and save them there."
        )

    flow = InstalledAppFlow.from_client_secrets_file(str(credentials_path), SCOPES)
    creds = flow.run_local_server(port=0)

    # Store token in Keychain
    store_token(creds)

    # Get user's email address
    service = _build_service(creds)
    profile = service.users().getProfile(userId="me").execute()
    email = profile.get("emailAddress", "unknown")

    return email


def get_gmail_service():
    """Get authenticated Gmail API service.

    Returns:
        Gmail API service object, or None if not authenticated
    """
    creds = get_token()

    if not creds:
        return None

    # Refresh token if expired
    if creds.expired and creds.refresh_token:
        if not _refresh_credentials(creds, source="get_service"):
            return None
        store_token(creds)

    if not creds.valid:
        return None

    return _build_service(creds)
