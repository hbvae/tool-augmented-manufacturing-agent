# 证据审计报告

该报告检查工具证据是否被保存、外部来源是否进入最终回答、关键结论是否就近引用，以及内部查询血缘是否可追溯。

| 任务 | 组别 | 审计状态 | 工具证据 | 检索/引用来源 | 引用利用率 | 外部声明绑定率 | 内部声明绑定率 | 综合绑定率 | 来源表 | 查询数 | 审计错误 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| E01 | context_baseline | complete | 2 | 16/10 | 62.5% | 93.3% | 不适用 | 93.3% | 无 | 0 | 无 |
| E01 | agent | complete | 4 | 32/15 | 46.9% | 85.7% | 不适用 | 85.7% | 无 | 0 | 无 |
| E01 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E02 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E02 | context_baseline | complete | 1 | 8/7 | 87.5% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E02 | agent | complete | 3 | 19/12 | 63.2% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E03 | agent | complete | 4 | 23/7 | 30.4% | 77.8% | 不适用 | 77.8% | 无 | 0 | 无 |
| E03 | context_baseline | complete | 2 | 6/5 | 83.3% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E03 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E04 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E04 | context_baseline | complete | 1 | 8/6 | 75.0% | 85.7% | 不适用 | 85.7% | 无 | 0 | 无 |
| E04 | agent | complete | 4 | 38/12 | 31.6% | 83.3% | 不适用 | 83.3% | 无 | 0 | 无 |
| E05 | context_baseline | complete | 1 | 8/7 | 87.5% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E05 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E05 | agent | complete | 4 | 32/9 | 28.1% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E06 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E06 | agent | complete | 3 | 13/6 | 46.2% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E06 | context_baseline | complete | 1 | 8/6 | 75.0% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E07 | agent | complete | 4 | 23/13 | 56.5% | 80.0% | 不适用 | 80.0% | 无 | 0 | 无 |
| E07 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E07 | context_baseline | complete | 1 | 8/7 | 87.5% | 90.0% | 不适用 | 90.0% | 无 | 0 | 无 |
| E08 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E08 | context_baseline | complete | 1 | 8/7 | 87.5% | 87.5% | 不适用 | 87.5% | 无 | 0 | 无 |
| E08 | agent | complete | 2 | 16/8 | 50.0% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| I01 | context_baseline | complete | 2 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 43 | 无 |
| I01 | agent | complete | 7 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, inventory_transactions, machines, materials, production_orders, products, quality_inspections, supplier_receipts, suppliers | 110 | 无 |
| I01 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I02 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 1 | 无 |
| I02 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I02 | context_baseline | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 1 | 无 |
| I03 | agent | complete | 2 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 14 | 无 |
| I03 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I03 | context_baseline | complete | 2 | 0/0 | 不适用 | 不适用 | 75.0% | 75.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 23 | 无 |
| I04 | context_baseline | complete | 2 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | inventory_transactions, materials, products, supplier_receipts, suppliers | 3 | 无 |
| I04 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 不适用 | 不适用 | 无 | 0 | 无 |
| I04 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | inventory_transactions, materials, products, supplier_receipts, suppliers | 4 | 无 |
| I05 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | energy_readings, machines, production_orders | 2 | 无 |
| I05 | context_baseline | complete | 1 | 0/0 | 不适用 | 不适用 | 90.5% | 90.5% | energy_readings, machines, production_orders | 2 | 无 |
| I05 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I06 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I06 | context_baseline | complete | 2 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, inventory_transactions, machines, materials, production_orders, products, quality_inspections, supplier_receipts, suppliers | 21 | 无 |
| I06 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, inventory_transactions, machines, materials, production_orders, products, quality_inspections | 15 | 无 |
| I07 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I07 | context_baseline | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | energy_readings, machines | 1 | 无 |
| I07 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 91.7% | 91.7% | downtime_events, energy_readings, inventory_transactions, machines, materials, production_orders, products, quality_inspections, supplier_receipts, suppliers | 33 | 无 |
| I08 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | production_orders | 1 | 无 |
| I08 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I08 | context_baseline | complete | 1 | 0/0 | 不适用 | 不适用 | 85.7% | 85.7% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 9 | 无 |
| H01 | context_baseline | complete | 3 | 8/5 | 62.5% | 100.0% | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 38 | 无 |
| H01 | agent | complete | 7 | 18/3 | 16.7% | 100.0% | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 33 | 无 |
| H01 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| H02 | agent | complete | 3 | 8/7 | 87.5% | 100.0% | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 14 | 无 |
| H02 | context_baseline | partial | 3 | 8/6 | 75.0% | 66.7% | 87.5% | 81.8% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 10 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H02 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H03 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 0.0% | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H03 | context_baseline | complete | 2 | 8/5 | 62.5% | 100.0% | 100.0% | 100.0% | machines, production_orders, products, quality_inspections | 1 | 无 |
| H03 | agent | complete | 3 | 8/5 | 62.5% | 100.0% | 100.0% | 100.0% | machines, production_orders, products, quality_inspections | 2 | 无 |
| H04 | agent | partial | 2 | 6/3 | 50.0% | 50.0% | 78.6% | 75.0% | energy_readings, machines, production_orders | 2 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H04 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 不适用 | 不适用 | 无 | 0 | 无 |
| H04 | context_baseline | complete | 2 | 8/5 | 62.5% | 83.3% | 100.0% | 90.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 9 | 无 |
| H05 | agent | complete | 4 | 11/6 | 54.5% | 83.3% | 90.0% | 86.4% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 39 | 无 |
| H05 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| H05 | context_baseline | complete | 3 | 8/7 | 87.5% | 100.0% | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 35 | 无 |
| H06 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H06 | context_baseline | complete | 2 | 8/4 | 50.0% | 100.0% | 100.0% | 100.0% | materials, supplier_receipts, suppliers | 1 | 无 |
| H06 | agent | complete | 2 | 6/6 | 100.0% | 100.0% | 100.0% | 100.0% | inventory_transactions, materials, products, supplier_receipts, suppliers | 4 | 无 |
| H07 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H07 | agent | complete | 3 | 6/4 | 66.7% | 80.0% | 100.0% | 90.9% | inventory_transactions, materials, products, supplier_receipts, suppliers | 6 | 无 |
| H07 | context_baseline | complete | 2 | 8/4 | 50.0% | 100.0% | 100.0% | 100.0% | materials, supplier_receipts, suppliers | 1 | 无 |
| H08 | context_baseline | complete | 2 | 8/6 | 75.0% | 100.0% | 100.0% | 100.0% | materials, supplier_receipts, suppliers | 1 | 无 |
| H08 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H08 | agent | complete | 6 | 8/6 | 75.0% | 100.0% | 100.0% | 100.0% | downtime_events, energy_readings, inventory_transactions, machines, materials, production_orders, products, quality_inspections, supplier_receipts, suppliers | 69 | 无 |
| E01 | agent | complete | 4 | 32/13 | 40.6% | 96.3% | 不适用 | 96.3% | 无 | 0 | 无 |
| E01 | context_baseline | complete | 2 | 16/11 | 68.8% | 83.3% | 不适用 | 83.3% | 无 | 0 | 无 |
| E01 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E02 | agent | complete | 4 | 30/14 | 46.7% | 85.7% | 不适用 | 85.7% | 无 | 0 | 无 |
| E02 | context_baseline | complete | 1 | 8/8 | 100.0% | 88.9% | 不适用 | 88.9% | 无 | 0 | 无 |
| E02 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E03 | agent | complete | 4 | 9/8 | 88.9% | 84.6% | 不适用 | 84.6% | 无 | 0 | 无 |
| E03 | context_baseline | partial | 2 | 6/5 | 83.3% | 50.0% | 不适用 | 50.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E03 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E04 | agent | complete | 4 | 30/18 | 60.0% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E04 | context_baseline | complete | 1 | 8/7 | 87.5% | 87.5% | 不适用 | 87.5% | 无 | 0 | 无 |
| E04 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E05 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E05 | agent | partial | 14 | 37/15 | 40.5% | 69.2% | 不适用 | 69.2% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 70 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E05 | context_baseline | complete | 1 | 8/8 | 100.0% | 83.3% | 不适用 | 83.3% | 无 | 0 | 无 |
| E06 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E06 | agent | complete | 3 | 12/6 | 50.0% | 不适用 | 不适用 | 不适用 | 无 | 0 | 无 |
| E06 | context_baseline | complete | 1 | 8/5 | 62.5% | 不适用 | 不适用 | 不适用 | 无 | 0 | 无 |
| E07 | agent | complete | 4 | 24/14 | 58.3% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E07 | context_baseline | complete | 1 | 8/8 | 100.0% | 75.0% | 不适用 | 75.0% | 无 | 0 | 无 |
| E07 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E08 | agent | complete | 3 | 15/8 | 53.3% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E08 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E08 | context_baseline | complete | 1 | 8/7 | 87.5% | 85.7% | 不适用 | 85.7% | 无 | 0 | 无 |
| I01 | agent | complete | 5 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 35 | 无 |
| I01 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I01 | context_baseline | complete | 2 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 43 | 无 |
| I02 | context_baseline | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 1 | 无 |
| I02 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 不适用 | 不适用 | 无 | 0 | 无 |
| I02 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 1 | 无 |
| I03 | context_baseline | complete | 2 | 0/0 | 不适用 | 不适用 | 91.7% | 91.7% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 23 | 无 |
| I03 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I03 | agent | complete | 2 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 14 | 无 |
| I04 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 不适用 | 不适用 | 无 | 0 | 无 |
| I04 | context_baseline | complete | 2 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | inventory_transactions, materials, products, supplier_receipts, suppliers | 3 | 无 |
| I04 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 93.3% | 93.3% | inventory_transactions, materials, products, supplier_receipts, suppliers | 4 | 无 |
| I05 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 78.6% | 78.6% | energy_readings, machines, production_orders | 2 | 无 |
| I05 | context_baseline | complete | 1 | 0/0 | 不适用 | 不适用 | 86.4% | 86.4% | energy_readings, machines, production_orders | 2 | 无 |
| I05 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I06 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, inventory_transactions, machines, materials, production_orders, products, quality_inspections | 15 | 无 |
| I06 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I06 | context_baseline | complete | 2 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, inventory_transactions, machines, materials, production_orders, products, quality_inspections, supplier_receipts, suppliers | 21 | 无 |
| I07 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, inventory_transactions, machines, materials, production_orders, products, quality_inspections, supplier_receipts, suppliers | 33 | 无 |
| I07 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I07 | context_baseline | complete | 1 | 0/0 | 不适用 | 不适用 | 80.0% | 80.0% | energy_readings, machines | 1 | 无 |
| I08 | context_baseline | complete | 1 | 0/0 | 不适用 | 不适用 | 90.0% | 90.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 9 | 无 |
| I08 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | production_orders | 1 | 无 |
| I08 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| H01 | context_baseline | complete | 3 | 8/5 | 62.5% | 100.0% | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 38 | 无 |
| H01 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H01 | agent | complete | 5 | 18/4 | 22.2% | 100.0% | 80.0% | 83.3% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 24 | 无 |
| H02 | agent | partial | 3 | 6/5 | 83.3% | 60.0% | 100.0% | 83.3% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 14 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H02 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 0.0% | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H02 | context_baseline | complete | 3 | 8/6 | 75.0% | 100.0% | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 10 | 无 |
| H03 | agent | complete | 3 | 8/4 | 50.0% | 100.0% | 100.0% | 100.0% | machines, production_orders, products, quality_inspections | 2 | 无 |
| H03 | context_baseline | complete | 2 | 8/5 | 62.5% | 100.0% | 100.0% | 100.0% | machines, production_orders, products, quality_inspections | 1 | 无 |
| H03 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H04 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H04 | agent | complete | 3 | 12/4 | 33.3% | 100.0% | 100.0% | 100.0% | energy_readings, machines, production_orders | 2 | 无 |
| H04 | context_baseline | complete | 2 | 8/4 | 50.0% | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 9 | 无 |
| H05 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 0.0% | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H05 | agent | complete | 4 | 11/6 | 54.5% | 87.5% | 100.0% | 92.9% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 39 | 无 |
| H05 | context_baseline | complete | 3 | 8/5 | 62.5% | 100.0% | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 35 | 无 |
| H06 | agent | complete | 2 | 6/5 | 83.3% | 100.0% | 100.0% | 100.0% | inventory_transactions, materials, products, supplier_receipts, suppliers | 4 | 无 |
| H06 | context_baseline | complete | 2 | 8/4 | 50.0% | 100.0% | 100.0% | 100.0% | materials, supplier_receipts, suppliers | 1 | 无 |
| H06 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 0.0% | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H07 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H07 | agent | complete | 3 | 6/3 | 50.0% | 75.0% | 100.0% | 92.9% | inventory_transactions, materials, products, supplier_receipts, suppliers | 6 | 无 |
| H07 | context_baseline | complete | 2 | 8/4 | 50.0% | 不适用 | 75.0% | 75.0% | materials, supplier_receipts, suppliers | 1 | 无 |
| H08 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H08 | context_baseline | complete | 2 | 8/4 | 50.0% | 100.0% | 100.0% | 100.0% | materials, supplier_receipts, suppliers | 1 | 无 |
| H08 | agent | complete | 6 | 8/8 | 100.0% | 100.0% | 78.6% | 83.3% | downtime_events, energy_readings, inventory_transactions, machines, materials, production_orders, products, quality_inspections, supplier_receipts, suppliers | 69 | 无 |
| E01 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E01 | context_baseline | complete | 2 | 16/10 | 62.5% | 93.3% | 不适用 | 93.3% | 无 | 0 | 无 |
| E01 | agent | partial | 4 | 30/17 | 56.7% | 92.9% | 不适用 | 92.9% | 无 | 0 | ORIGINAL_SOURCE_DIVERSITY_INSUFFICIENT |
| E02 | agent | complete | 3 | 19/12 | 63.2% | 88.9% | 不适用 | 88.9% | 无 | 0 | 无 |
| E02 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E02 | context_baseline | complete | 1 | 8/7 | 87.5% | 83.3% | 不适用 | 83.3% | 无 | 0 | 无 |
| E03 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E03 | context_baseline | complete | 2 | 6/4 | 66.7% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E03 | agent | complete | 4 | 16/9 | 56.2% | 80.0% | 不适用 | 80.0% | 无 | 0 | 无 |
| E04 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E04 | context_baseline | complete | 1 | 8/5 | 62.5% | 85.7% | 不适用 | 85.7% | 无 | 0 | 无 |
| E04 | agent | complete | 4 | 29/10 | 34.5% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E05 | context_baseline | complete | 1 | 8/6 | 75.0% | 88.9% | 不适用 | 88.9% | 无 | 0 | 无 |
| E05 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E05 | agent | complete | 4 | 27/10 | 37.0% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E06 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E06 | context_baseline | complete | 1 | 8/6 | 75.0% | 不适用 | 不适用 | 不适用 | 无 | 0 | 无 |
| E06 | agent | complete | 3 | 13/6 | 46.2% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E07 | agent | complete | 4 | 23/14 | 60.9% | 80.0% | 不适用 | 80.0% | 无 | 0 | 无 |
| E07 | context_baseline | complete | 1 | 8/8 | 100.0% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E07 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E08 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| E08 | context_baseline | complete | 1 | 8/7 | 87.5% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| E08 | agent | complete | 4 | 22/14 | 63.6% | 100.0% | 不适用 | 100.0% | 无 | 0 | 无 |
| I01 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I01 | context_baseline | complete | 2 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 43 | 无 |
| I01 | agent | complete | 5 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 68 | 无 |
| I02 | context_baseline | complete | 1 | 0/0 | 不适用 | 不适用 | 90.0% | 90.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 1 | 无 |
| I02 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I02 | agent | complete | 2 | 0/0 | 不适用 | 不适用 | 88.9% | 88.9% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 11 | 无 |
| I03 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I03 | context_baseline | complete | 2 | 0/0 | 不适用 | 不适用 | 88.9% | 88.9% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 23 | 无 |
| I03 | agent | complete | 2 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 24 | 无 |
| I04 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 不适用 | 不适用 | 无 | 0 | 无 |
| I04 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | inventory_transactions, materials, products, supplier_receipts, suppliers | 4 | 无 |
| I04 | context_baseline | complete | 2 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | inventory_transactions, materials, products, supplier_receipts, suppliers | 3 | 无 |
| I05 | context_baseline | complete | 1 | 0/0 | 不适用 | 不适用 | 76.2% | 76.2% | energy_readings, machines, production_orders | 2 | 无 |
| I05 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 75.0% | 75.0% | energy_readings, machines, production_orders | 2 | 无 |
| I05 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I06 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 不适用 | 不适用 | 无 | 0 | 无 |
| I06 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 88.9% | 88.9% | downtime_events, energy_readings, inventory_transactions, machines, materials, production_orders, products, quality_inspections | 15 | 无 |
| I06 | context_baseline | complete | 2 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, inventory_transactions, machines, materials, production_orders, products, quality_inspections, supplier_receipts, suppliers | 21 | 无 |
| I07 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 不适用 | 不适用 | 无 | 0 | 无 |
| I07 | context_baseline | complete | 1 | 0/0 | 不适用 | 不适用 | 83.3% | 83.3% | energy_readings, machines | 1 | 无 |
| I07 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, inventory_transactions, machines, materials, production_orders, products, quality_inspections, supplier_receipts, suppliers | 33 | 无 |
| I08 | agent | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | production_orders | 1 | 无 |
| I08 | baseline | complete | 0 | 0/0 | 不适用 | 不适用 | 0.0% | 0.0% | 无 | 0 | 无 |
| I08 | context_baseline | complete | 1 | 0/0 | 不适用 | 不适用 | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 9 | 无 |
| H01 | agent | complete | 7 | 24/4 | 16.7% | 100.0% | 88.9% | 92.3% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 33 | 无 |
| H01 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 0.0% | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H01 | context_baseline | complete | 3 | 8/4 | 50.0% | 100.0% | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 38 | 无 |
| H02 | agent | complete | 3 | 6/4 | 66.7% | 100.0% | 90.9% | 92.3% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 14 | 无 |
| H02 | context_baseline | partial | 3 | 8/6 | 75.0% | 66.7% | 100.0% | 90.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 10 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H02 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H03 | context_baseline | complete | 2 | 8/5 | 62.5% | 不适用 | 100.0% | 100.0% | machines, production_orders, products, quality_inspections | 1 | 无 |
| H03 | agent | complete | 3 | 8/8 | 100.0% | 100.0% | 80.0% | 85.7% | machines, production_orders, products, quality_inspections | 2 | 无 |
| H03 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 0.0% | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H04 | context_baseline | partial | 2 | 8/4 | 50.0% | 50.0% | 100.0% | 80.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 9 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H04 | agent | complete | 3 | 12/5 | 41.7% | 100.0% | 100.0% | 100.0% | energy_readings, machines, production_orders | 2 | 无 |
| H04 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H05 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H05 | agent | complete | 3 | 6/5 | 83.3% | 100.0% | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 39 | 无 |
| H05 | context_baseline | complete | 3 | 8/4 | 50.0% | 100.0% | 100.0% | 100.0% | downtime_events, energy_readings, machines, production_orders, products, quality_inspections | 35 | 无 |
| H06 | agent | complete | 3 | 12/6 | 50.0% | 100.0% | 100.0% | 100.0% | inventory_transactions, materials, products, supplier_receipts, suppliers | 4 | 无 |
| H06 | context_baseline | complete | 2 | 8/4 | 50.0% | 100.0% | 100.0% | 100.0% | materials, supplier_receipts, suppliers | 1 | 无 |
| H06 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 0.0% | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H07 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 不适用 | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H07 | agent | complete | 3 | 6/5 | 83.3% | 100.0% | 100.0% | 100.0% | inventory_transactions, materials, products, supplier_receipts, suppliers | 6 | 无 |
| H07 | context_baseline | complete | 2 | 8/6 | 75.0% | 100.0% | 83.3% | 88.9% | materials, supplier_receipts, suppliers | 1 | 无 |
| H08 | baseline | insufficient | 0 | 0/0 | 不适用 | 0.0% | 0.0% | 0.0% | 无 | 0 | KEY_CLAIMS_LACK_INLINE_CITATIONS |
| H08 | agent | complete | 6 | 8/5 | 62.5% | 100.0% | 100.0% | 100.0% | downtime_events, energy_readings, inventory_transactions, machines, materials, production_orders, products, quality_inspections, supplier_receipts, suppliers | 69 | 无 |
| H08 | context_baseline | complete | 2 | 8/7 | 87.5% | 100.0% | 100.0% | 100.0% | materials, supplier_receipts, suppliers | 1 | 无 |

- 工具证据记录：353 条
- `tool_evidence.jsonl` 只保存脱敏参数、摘要、血缘、哈希和精简结果，不保存完整大结果。
