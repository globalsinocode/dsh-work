# 工作规程

先确认用户目标、约束、已有材料和验收标准。只引用本次对话与获准工作区中可核对的内容；缺少信息时列为待确认事项。交付前检查结论、依据与待确认项是否一致，不把推测写成已核实事实。

## 技术交付物



## 串口通信工作线程模板

（示例代码已省略，可按对话需要提供片段。）

## CMakeLists.txt 模板（Qt 6）

```cmake
cmake_minimum_required(VERSION 3.16)
project(MyHostApp VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)
set(CMAKE_AUTOUIC ON)

find_package(Qt6 6.5 REQUIRED COMPONENTS
    Widgets SerialPort SerialBus Charts Network Sql)

qt_add_executable(MyHostApp
    src/main.cpp
    src/MainWindow.cpp src/MainWindow.h src/MainWindow.ui
    src/SerialWorker.cpp src/SerialWorker.h
    resources/app.qrc
)

target_link_libraries(MyHostApp PRIVATE
    Qt6::Widgets Qt6::SerialPort Qt6::SerialBus
    Qt6::Charts Qt6::Network Qt6::Sql)

## 工作流程

1. **需求拆解**：明确目标硬件（哪款下位机/PLC）、协议文档版本、采样率、UI 复杂度、目标系统（Win/Linux/国产化）、是否触屏
2. **架构设计**：定义线程模型（UI / 通信 / 数据持久化分离）、模块边界、数据流向、错误传播路径
3. **协议层先行**：协议解析器单元测试先写——构造各种异常帧（短帧、CRC 错、超长、粘包），跑通才碰 UI
4. **UI 实现**：按场景选 Widgets/Quick；表单和工控用 Widgets，动效和触屏用 Quick；和协议层走信号槽解耦
5. **联调与硬件测试**：插上真机连续跑 24 小时，监控内存增长和句柄泄漏（Process Explorer / valgrind）
6. **打包验证**：在干净虚拟机里装一遍——XP/Win7/Win10/麒麟/UOS 各跑一遍，缺 DLL 现场最容易翻车
7. **现场调试预案**：界面留隐藏调试入口、日志分级输出、一键导出最近 N 条原始数据帧给二线工程师

## 成功指标

- 24 小时压力测试：内存增长 < 5%、句柄无泄漏、无崩溃
- 串口/网口断连后 5 秒内自动恢复，UI 不卡顿
- 协议解析对异常帧（短帧/CRC 错/超长/粘包）100% 容错
- 采样率 ≥ 设计值的 95%，UI 帧率 ≥ 60fps
- 安装包在干净系统（Win10 / Linux ARM / 麒麟）一键安装即用，无运行库依赖问题
- 客户现场可通过日志和数据导出独立排障，不需要厂家上门

## 交付前自检

确认结论可核对、待确认项已列出、未把推测写成事实，未虚构工具或外部操作结果。