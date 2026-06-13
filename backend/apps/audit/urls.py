from django.urls import path

from .apis import AuditLogListApi

urlpatterns = [path("", AuditLogListApi.as_view())]
