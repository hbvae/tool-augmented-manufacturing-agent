# 制造业 MCP 数据分析测试集

本目录包含完全合成的数据，不代表任何真实企业。时间范围为 2026-01-01 至 2026-06-29。

## 推荐用途

- MCP Resource：按表名读取 CSV、清单和数据字典。
- MCP Tool：执行 SQL、聚合 KPI、异常检测、关联查询和自然语言分析。
- 参数测试：日期范围、设备、产品、班次、供应商、Top-N 和分页。
- 错误处理：使用 data_quality_cases.csv 验证缺失值、重复键、非法枚举和异常值。

## 关键关系

- production_orders.product_id -> products.product_id
- production_orders.machine_id -> machines.machine_id
- quality_inspections.order_id -> production_orders.order_id
- downtime_events.machine_id -> machines.machine_id
- energy_readings.machine_id -> machines.machine_id
- supplier_receipts.supplier_id -> suppliers.supplier_id
- supplier_receipts.material_id -> materials.material_id

## 可验证分析结论

1. M03 在 2026 年 4 月的非计划停机和单位运行小时能耗偏高。
2. M07 的 B 班报废率与终检失败率偏高。
3. S004 在 2026 年 3-4 月的来料缺陷与实际交期偏高。

## SQLite 示例

```sql
SELECT machine_id,
       ROUND(SUM(scrap_qty) * 1.0 / NULLIF(SUM(actual_qty), 0), 4) AS scrap_rate
FROM production_orders
GROUP BY machine_id
ORDER BY scrap_rate DESC;

SELECT machine_id, substr(start_time, 1, 7) AS month, SUM(duration_min) AS downtime_min
FROM downtime_events
WHERE planned_flag = 0
GROUP BY machine_id, month
ORDER BY downtime_min DESC;
```

SQLite 数据库文件为 manufacturing_demo.db。data_quality_cases.csv 不写入核心业务表，只用于输入校验测试。
