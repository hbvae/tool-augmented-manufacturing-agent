# 智能体工具效率审计

该报告只做诊断，不限制智能体工具调用次数。效率分是透明启发式指标，应与任务完成和证据状态一起解释。

| 任务 | 组别 | 状态 | 效率分 | 调用数 | 唯一工具 | 精确重复 | 发现调用 | 高层分析 | 通用问答 | 外部检索 | 沙箱 | 有证据调用率 | 告警 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| E01 | context_baseline | efficient | 100.0 | 2 | 1 | 0 | 0 | 0 | 0 | 2 | 0 | 100.0% | 无 |
| E01 | agent | review | 85.0 | 4 | 1 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E01 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E02 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E02 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E02 | agent | review | 90.0 | 3 | 1 | 0 | 0 | 0 | 0 | 3 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| E03 | agent | review | 85.0 | 4 | 2 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E03 | context_baseline | efficient | 100.0 | 2 | 1 | 0 | 0 | 0 | 0 | 2 | 0 | 100.0% | 无 |
| E03 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E04 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E04 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E04 | agent | review | 85.0 | 4 | 1 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E05 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E05 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E05 | agent | review | 85.0 | 4 | 1 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E06 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E06 | agent | review | 90.0 | 3 | 1 | 0 | 0 | 0 | 0 | 3 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| E06 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E07 | agent | review | 85.0 | 4 | 2 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E07 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E07 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E08 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E08 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E08 | agent | review | 90.0 | 2 | 1 | 0 | 0 | 0 | 0 | 2 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| I01 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 100.0% | 无 |
| I01 | agent | review | 80.0 | 7 | 6 | 0 | 0 | 6 | 1 | 0 | 0 | 100.0% | SEMANTICALLY_REDUNDANT_RISK_TOOLS, MODEL_CONTEXT_TOKEN_HIGH |
| I01 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I02 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I02 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I02 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I03 | agent | efficient | 100.0 | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 100.0% | 无 |
| I03 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I03 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 1 | 1 | 0 | 0 | 100.0% | 无 |
| I04 | context_baseline | efficient | 100.0 | 2 | 1 | 0 | 0 | 0 | 2 | 0 | 0 | 100.0% | 无 |
| I04 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I04 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I05 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I05 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I05 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I06 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I06 | context_baseline | efficient | 100.0 | 2 | 1 | 0 | 0 | 0 | 2 | 0 | 0 | 100.0% | 无 |
| I06 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I07 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I07 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 100.0% | 无 |
| I07 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I08 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 100.0% | 无 |
| I08 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I08 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 100.0% | 无 |
| H01 | context_baseline | efficient | 100.0 | 3 | 2 | 0 | 0 | 0 | 2 | 1 | 0 | 100.0% | 无 |
| H01 | agent | review | 85.0 | 7 | 4 | 0 | 0 | 3 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| H01 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H02 | agent | review | 90.0 | 3 | 3 | 0 | 0 | 2 | 0 | 1 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| H02 | context_baseline | efficient | 100.0 | 3 | 2 | 0 | 0 | 0 | 2 | 1 | 0 | 100.0% | 无 |
| H02 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H03 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H03 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |
| H03 | agent | efficient | 100.0 | 3 | 2 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| H04 | agent | efficient | 100.0 | 2 | 2 | 0 | 0 | 1 | 0 | 1 | 0 | 100.0% | 无 |
| H04 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H04 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |
| H05 | agent | review | 90.0 | 4 | 3 | 0 | 0 | 2 | 0 | 2 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| H05 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H05 | context_baseline | efficient | 100.0 | 3 | 2 | 0 | 0 | 0 | 2 | 1 | 0 | 100.0% | 无 |
| H06 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H06 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |
| H06 | agent | review | 90.0 | 2 | 2 | 0 | 0 | 1 | 0 | 1 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| H07 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H07 | agent | efficient | 100.0 | 3 | 3 | 0 | 0 | 1 | 0 | 1 | 0 | 100.0% | 无 |
| H07 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |
| H08 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |
| H08 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H08 | agent | review | 90.0 | 6 | 6 | 0 | 0 | 4 | 0 | 1 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| E01 | agent | review | 85.0 | 4 | 1 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E01 | context_baseline | efficient | 100.0 | 2 | 1 | 0 | 0 | 0 | 0 | 2 | 0 | 100.0% | 无 |
| E01 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E02 | agent | review | 85.0 | 4 | 1 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E02 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E02 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E03 | agent | review | 85.0 | 4 | 3 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E03 | context_baseline | efficient | 100.0 | 2 | 1 | 0 | 0 | 0 | 0 | 2 | 0 | 100.0% | 无 |
| E03 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E04 | agent | review | 85.0 | 4 | 1 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E04 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E04 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E05 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E05 | agent | review | 85.0 | 14 | 8 | 0 | 2 | 4 | 1 | 4 | 3 | 78.6% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E05 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E06 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E06 | agent | review | 90.0 | 3 | 1 | 0 | 0 | 0 | 0 | 3 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| E06 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E07 | agent | review | 85.0 | 4 | 2 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E07 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E07 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E08 | agent | review | 90.0 | 3 | 1 | 0 | 0 | 0 | 0 | 3 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| E08 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E08 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| I01 | agent | review | 90.0 | 5 | 4 | 0 | 0 | 3 | 1 | 0 | 1 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| I01 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I01 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 100.0% | 无 |
| I02 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I02 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I02 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I03 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 1 | 1 | 0 | 0 | 100.0% | 无 |
| I03 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I03 | agent | efficient | 100.0 | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 100.0% | 无 |
| I04 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I04 | context_baseline | efficient | 100.0 | 2 | 1 | 0 | 0 | 0 | 2 | 0 | 0 | 100.0% | 无 |
| I04 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I05 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I05 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I05 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I06 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I06 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I06 | context_baseline | efficient | 100.0 | 2 | 1 | 0 | 0 | 0 | 2 | 0 | 0 | 100.0% | 无 |
| I07 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I07 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I07 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 100.0% | 无 |
| I08 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 100.0% | 无 |
| I08 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 100.0% | 无 |
| I08 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H01 | context_baseline | efficient | 100.0 | 3 | 2 | 0 | 0 | 0 | 2 | 1 | 0 | 100.0% | 无 |
| H01 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H01 | agent | review | 90.0 | 5 | 3 | 0 | 0 | 2 | 0 | 3 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| H02 | agent | review | 90.0 | 3 | 3 | 0 | 0 | 2 | 0 | 1 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| H02 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H02 | context_baseline | efficient | 100.0 | 3 | 2 | 0 | 0 | 0 | 2 | 1 | 0 | 100.0% | 无 |
| H03 | agent | efficient | 100.0 | 3 | 2 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| H03 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |
| H03 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H04 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H04 | agent | review | 90.0 | 3 | 2 | 0 | 0 | 1 | 0 | 2 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| H04 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |
| H05 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H05 | agent | review | 90.0 | 4 | 3 | 0 | 0 | 2 | 0 | 2 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| H05 | context_baseline | efficient | 100.0 | 3 | 2 | 0 | 0 | 0 | 2 | 1 | 0 | 100.0% | 无 |
| H06 | agent | review | 90.0 | 2 | 2 | 0 | 0 | 1 | 0 | 1 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| H06 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |
| H06 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H07 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H07 | agent | efficient | 100.0 | 3 | 3 | 0 | 0 | 1 | 0 | 1 | 0 | 100.0% | 无 |
| H07 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |
| H08 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H08 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |
| H08 | agent | review | 90.0 | 6 | 6 | 0 | 0 | 4 | 0 | 1 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| E01 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E01 | context_baseline | efficient | 100.0 | 2 | 1 | 0 | 0 | 0 | 0 | 2 | 0 | 100.0% | 无 |
| E01 | agent | review | 85.0 | 4 | 1 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E02 | agent | review | 90.0 | 3 | 1 | 0 | 0 | 0 | 0 | 3 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| E02 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E02 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E03 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E03 | context_baseline | efficient | 100.0 | 2 | 1 | 0 | 0 | 0 | 0 | 2 | 0 | 100.0% | 无 |
| E03 | agent | review | 85.0 | 4 | 2 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E04 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E04 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E04 | agent | review | 85.0 | 4 | 1 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E05 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E05 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E05 | agent | review | 85.0 | 4 | 1 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E06 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E06 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E06 | agent | review | 90.0 | 3 | 1 | 0 | 0 | 0 | 0 | 3 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| E07 | agent | review | 85.0 | 4 | 2 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| E07 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E07 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E08 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| E08 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| E08 | agent | review | 85.0 | 4 | 2 | 0 | 0 | 0 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| I01 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I01 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 100.0% | 无 |
| I01 | agent | review | 90.0 | 5 | 4 | 0 | 0 | 4 | 1 | 0 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| I02 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I02 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I02 | agent | efficient | 100.0 | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 100.0% | 无 |
| I03 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I03 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 1 | 1 | 0 | 0 | 100.0% | 无 |
| I03 | agent | efficient | 100.0 | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 100.0% | 无 |
| I04 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I04 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I04 | context_baseline | efficient | 100.0 | 2 | 1 | 0 | 0 | 0 | 2 | 0 | 0 | 100.0% | 无 |
| I05 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I05 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I05 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I06 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I06 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I06 | context_baseline | efficient | 100.0 | 2 | 1 | 0 | 0 | 0 | 2 | 0 | 0 | 100.0% | 无 |
| I07 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I07 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 100.0% | 无 |
| I07 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 100.0% | 无 |
| I08 | agent | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 100.0% | 无 |
| I08 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| I08 | context_baseline | efficient | 100.0 | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 100.0% | 无 |
| H01 | agent | review | 85.0 | 7 | 3 | 0 | 0 | 3 | 0 | 4 | 0 | 100.0% | EXTERNAL_SEARCH_FANOUT_HIGH, MODEL_CONTEXT_TOKEN_HIGH |
| H01 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H01 | context_baseline | efficient | 100.0 | 3 | 2 | 0 | 0 | 0 | 2 | 1 | 0 | 100.0% | 无 |
| H02 | agent | review | 90.0 | 3 | 3 | 0 | 0 | 2 | 0 | 1 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| H02 | context_baseline | efficient | 100.0 | 3 | 2 | 0 | 0 | 0 | 2 | 1 | 0 | 100.0% | 无 |
| H02 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H03 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |
| H03 | agent | efficient | 100.0 | 3 | 2 | 0 | 0 | 0 | 0 | 1 | 0 | 100.0% | 无 |
| H03 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H04 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |
| H04 | agent | review | 90.0 | 3 | 2 | 0 | 0 | 1 | 0 | 2 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| H04 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H05 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H05 | agent | review | 90.0 | 3 | 3 | 0 | 0 | 2 | 0 | 1 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| H05 | context_baseline | efficient | 100.0 | 3 | 2 | 0 | 0 | 0 | 2 | 1 | 0 | 100.0% | 无 |
| H06 | agent | review | 90.0 | 3 | 2 | 0 | 0 | 1 | 0 | 2 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| H06 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |
| H06 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H07 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H07 | agent | efficient | 100.0 | 3 | 3 | 0 | 0 | 1 | 0 | 1 | 0 | 100.0% | 无 |
| H07 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |
| H08 | baseline | not_applicable | 不适用 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 无 |
| H08 | agent | review | 90.0 | 6 | 6 | 0 | 0 | 4 | 0 | 1 | 0 | 100.0% | MODEL_CONTEXT_TOKEN_HIGH |
| H08 | context_baseline | efficient | 100.0 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 100.0% | 无 |

## 指标解释

- 精确重复：工具名与规范化参数摘要完全相同的重复调用。
- 发现调用：数据集、表结构、指标目录或运行状态查询。
- 高层分析：能够一次返回跨表综合证据的受控工具。
- 有证据调用率：返回外部来源、内部表血缘、查询记录或结构化结果的调用占比。
