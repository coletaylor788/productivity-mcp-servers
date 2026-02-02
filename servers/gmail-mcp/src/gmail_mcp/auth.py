"""Authentication module for Gmail MCP server."""

import json

import keyring
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from .config import KEYCHAIN_SERVICE, get_credentials_path

# Gmail API scopes
# - gmail.modify: read, write, and modify emails (includes archive)
# - gmail.send: send emails (used for integration tests)
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
]


def is_authenticated() -> bool:
    """Check if a valid token exists in Keychain.

    Returns:
        True if authenticated, False otherwise
    """
    token_data = keyring.get_password(KEYCHAIN_SERVICE, "token")
    return token_data is not None


def get_token() -> Credentials | None:
    """Retrieve credentials from Keychain.

    Returns:
        Credentials object if found and valid, None otherwise
    """
    token_data = keyring.get_password(KEYCHAIN_SERVICE, "token")
    if not token_data:
        return None

    try:
        token_info = json.loads(token_data)
        creds = Credentials.from_authorized_user_info(token_info, SCOPES)
        return creds
    except (json.JSONDecodeError, ValueError):
        return None


def store_token(creds: Credentials) -> None:
    """Save credentials to Keychain.

    Args:
        creds: Google OAuth credentials to store
    """
    token_data = creds.to_json()
    keyring.set_password(KEYCHAIN_SERVICE, "token", token_data)


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
        service = build("gmail", "v1", credentials=creds)
        profile = service.users().getProfile(userId="me").execute()
        return profile.get("emailAddress", "unknown")

    # Try to refresh expired token (only if scopes are correct)
    if creds and creds.expired and creds.refresh_token and _has_required_scopes(creds):
        try:
            creds.refresh(Request())
            store_token(creds)
            service = build("gmail", "v1", credentials=creds)
            profile = service.users().getProfile(userId="me").execute()
            return profile.get("emailAddress", "unknown")
        except Exception:
            # Refresh failed, need to re-authenticate
            pass

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
    service = build("gmail", "v1", credentials=creds)
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
        try:
            creds.refresh(Request())
            store_token(creds)
        except Exception:
            return None

    if not creds.valid:
        return None

    return build("gmail", "v1", credentials=creds)
