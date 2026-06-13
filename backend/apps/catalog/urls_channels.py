from django.urls import path

from .apis import ChannelDetailApi, ChannelListCreateApi

urlpatterns = [
    path("", ChannelListCreateApi.as_view()),
    path("<int:pk>/", ChannelDetailApi.as_view()),
]
