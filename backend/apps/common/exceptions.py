class ApplicationError(Exception):
    """
    Base business-logic error.

    Raised from services when a domain rule is violated.
    Translated to HTTP 400 by the DRF exception handler.
    """

    def __init__(self, message: str, extra: dict | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.extra = extra or {}


class DuplicateError(ApplicationError):
    """Raised when a uniqueness constraint is hit at the service level."""
