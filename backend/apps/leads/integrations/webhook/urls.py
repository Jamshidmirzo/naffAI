from django.urls import path

from .apis import LeadWebhookApi

# Mounted at /api/integrations/leads/ (config/api_urls.py).
urlpatterns = [
    path("<str:token>/", LeadWebhookApi.as_view(), name="lead-webhook"),
]
