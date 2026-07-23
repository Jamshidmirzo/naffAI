from django.urls import path

from .apis import MorningGreetingApi, MorningGreetingDismissApi

me_urlpatterns = [
    path("morning-greeting/", MorningGreetingApi.as_view()),
    path("morning-greeting/dismiss/", MorningGreetingDismissApi.as_view()),
]
