from django.urls import path

from .apis import ImeiLookupApi, PhoneModelSuggestApi

urlpatterns = [
    path("models/", PhoneModelSuggestApi.as_view()),
    path("<str:imei>/lookup/", ImeiLookupApi.as_view()),
]
