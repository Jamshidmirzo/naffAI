from django.urls import path

from .apis import ChatMessagesApi, ChatSessionListCreateApi

urlpatterns = [
    path("sessions/", ChatSessionListCreateApi.as_view()),
    path("sessions/<int:session_id>/messages/", ChatMessagesApi.as_view()),
]
