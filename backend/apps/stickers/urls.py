from django.urls import path

from .apis import (
    MySelfStickerApi,
    OperatorStickerApi,
    StickerPaletteApi,
)

palette_urlpatterns = [
    path("palette/", StickerPaletteApi.as_view()),
]

me_sticker_urlpatterns = [
    path("sticker/", MySelfStickerApi.as_view()),
]

operator_sticker_urlpatterns = [
    path("<int:pk>/sticker/", OperatorStickerApi.as_view()),
]
