from django.urls import path

from .apis import ImeiLookupApi

urlpatterns = [path("<str:imei>/lookup/", ImeiLookupApi.as_view())]
