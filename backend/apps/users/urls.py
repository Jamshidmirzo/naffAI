from django.urls import path

from .apis import LoginApi, LogoutApi, MeApi

urlpatterns = [
    path("login/", LoginApi.as_view()),
    path("logout/", LogoutApi.as_view()),
    path("me/", MeApi.as_view()),
]
