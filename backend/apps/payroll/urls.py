from django.urls import path

from .apis import (
    OperatorPayrollRuleApi,
    PayrollMonthlyApi,
    PayrollMonthlyExportApi,
    PayrollRuleDetailApi,
    PayrollRuleListCreateApi,
)

urlpatterns = [
    path("rules/", PayrollRuleListCreateApi.as_view()),
    path(
        "rules/operator/<int:operator_id>/",
        OperatorPayrollRuleApi.as_view(),
        name="payroll-rule-operator",
    ),
    path("rules/<int:pk>/", PayrollRuleDetailApi.as_view()),
    path("monthly/", PayrollMonthlyApi.as_view()),
    path("monthly/export.xlsx", PayrollMonthlyExportApi.as_view()),
]
