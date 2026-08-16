from django.urls import path

from .apis import (
    LoginApi,
    LogoutApi,
    MeApi,
    OperatorAccountActivateApi,
    OperatorAccountCreateApi,
    OperatorAccountDeactivateApi,
    OperatorAccountDeleteApi,
    OperatorAccountLanguageApi,
    OperatorAccountPasswordViewApi,
    OperatorAccountResetPasswordApi,
    SelfChangePasswordApi,
    TelegramLinkCodeApi,
)

# Auth surface — mounted at /api/auth/ from config.api_urls.
urlpatterns = [
    path("login/", LoginApi.as_view()),
    path("logout/", LogoutApi.as_view()),
    path("me/", MeApi.as_view()),
]


# Self-service password change — mounted at /api/me/.
me_urlpatterns = [
    path("change-password/", SelfChangePasswordApi.as_view()),
    path("telegram/link/", TelegramLinkCodeApi.as_view()),
]


# Manager admin surface — mounted at /api/operators/<id>/account/... via
# config.api_urls so the URL reads naturally next to operator CRUD.
operator_account_urlpatterns = [
    path(
        "<int:operator_id>/account/",
        OperatorAccountCreateApi.as_view(),
        name="operator-account-create",
    ),
    path(
        "<int:operator_id>/account/password/",
        OperatorAccountPasswordViewApi.as_view(),
        name="operator-account-password",
    ),
    path(
        "<int:operator_id>/account/reset-password/",
        OperatorAccountResetPasswordApi.as_view(),
        name="operator-account-reset-password",
    ),
    path(
        "<int:operator_id>/account/deactivate/",
        OperatorAccountDeactivateApi.as_view(),
        name="operator-account-deactivate",
    ),
    path(
        "<int:operator_id>/account/activate/",
        OperatorAccountActivateApi.as_view(),
        name="operator-account-activate",
    ),
    # DELETE and POST share the collection URL; ordering matters — the
    # create view is a POST, delete is a DELETE, so we register them
    # separately and Django routes by method.
    path(
        "<int:operator_id>/account/delete/",
        OperatorAccountDeleteApi.as_view(),
        name="operator-account-delete",
    ),
    path(
        "<int:operator_id>/account/language/",
        OperatorAccountLanguageApi.as_view(),
        name="operator-account-language",
    ),
]


# Manager-facing user CRUD for web accounts (managers/team-leads only —
# operators have their own /operators/{id}/account/… surface).
from .apis import UserDeleteApi, UserListCreateApi, UserResetPasswordApi, UserUpdateApi

users_urlpatterns = [
    path("", UserListCreateApi.as_view(), name="users-list-create"),
    path(
        "<int:user_id>/",
        UserUpdateApi.as_view(),
        name="user-update",
    ),
    path(
        "<int:user_id>/reset-password/",
        UserResetPasswordApi.as_view(),
        name="user-reset-password",
    ),
    path(
        "<int:user_id>/delete/",
        UserDeleteApi.as_view(),
        name="user-delete",
    ),
]
