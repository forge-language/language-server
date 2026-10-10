cmake_minimum_required(VERSION 3.16)
project(ForgeLanguageServer VERSION 0.1.0 LANGUAGES C)
include(GNUInstallDirs)
find_package(Forge CONFIG REQUIRED)
forge_add_executable(forge-lsp "${CMAKE_CURRENT_SOURCE_DIR}/native/main.fg")
install(PROGRAMS "${CMAKE_CURRENT_BINARY_DIR}/bin/forge-lsp" DESTINATION ${CMAKE_INSTALL_BINDIR})
install(PROGRAMS "${CMAKE_CURRENT_SOURCE_DIR}/scripts/doctor.py" DESTINATION ${CMAKE_INSTALL_BINDIR} RENAME forge-lsp-doctor)
install(FILES LICENSE DESTINATION ${CMAKE_INSTALL_DATADIR}/forge-lsp)
include(CTest)
if(BUILD_TESTING)
    find_package(Python3 COMPONENTS Interpreter REQUIRED)
    add_test(NAME lsp_doctor COMMAND ${Python3_EXECUTABLE} -m unittest discover -s "${CMAKE_CURRENT_SOURCE_DIR}/tests" -p test_doctor.py)
    add_test(NAME native_lsp_protocol COMMAND ${Python3_EXECUTABLE}
        "${CMAKE_CURRENT_SOURCE_DIR}/tests/native_protocol_test.py"
        "${CMAKE_CURRENT_BINARY_DIR}/bin/forge-lsp")
    if(UNIX)
        add_test(NAME native_lsp_async_protocol COMMAND ${Python3_EXECUTABLE}
            "${CMAKE_CURRENT_SOURCE_DIR}/tests/native_async_protocol_test.py"
            "${CMAKE_CURRENT_BINARY_DIR}/bin/forge-lsp")
        set_tests_properties(native_lsp_async_protocol PROPERTIES TIMEOUT 120)
        add_test(NAME native_lsp_diagnostics COMMAND ${Python3_EXECUTABLE}
            "${CMAKE_CURRENT_SOURCE_DIR}/tests/native_diagnostics_test.py"
            "${CMAKE_CURRENT_BINARY_DIR}/bin/forge-lsp" "${FORGE_BIN_DIR}/forge")
        set_tests_properties(native_lsp_diagnostics PROPERTIES TIMEOUT 30)
    endif()
endif()
