// Runs inside the Store package so Windows resolves Muxus's identity and licence.
// stdout is a JSON-lines protocol; only the explicit "install" command can update.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shobjidl.h>
#include <winrt/Windows.ApplicationModel.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Services.Store.h>
#include <algorithm>
#include <iostream>
#include <mutex>
#include <string>

using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Services::Store;

std::mutex outputMutex;
void emit(char const* status, int percent = -1) {
    std::lock_guard lock(outputMutex);
    std::cout << "{\"status\":\"" << status << "\"";
    if (percent >= 0) std::cout << ",\"percent\":" << percent;
    std::cout << "}" << std::endl;
}

IAsyncAction run(bool install, HWND owner) {
    auto package = Windows::ApplicationModel::Package::Current();
    if (package.Id().Name() != L"FloSch.me.Muxus") throw hresult_access_denied();
    auto context = StoreContext::GetDefault();
    check_hresult(context.as<IInitializeWithWindow>()->Initialize(owner));
    auto updates = co_await context.GetAppAndOptionalStorePackageUpdatesAsync();
    auto appUpdates = single_threaded_vector<StorePackageUpdate>();
    for (auto const& update : updates) {
        if (update.Package().Id().FamilyName() == package.Id().FamilyName()) appUpdates.Append(update);
    }
    if (appUpdates.Size() == 0) {
        emit("up-to-date");
        co_return;
    }
    if (!install) {
        // StorePackageUpdate.Package describes the installed package, not the
        // target version. Report availability without inventing a version number.
        emit("available");
        co_return;
    }
    auto operation = context.RequestDownloadAndInstallStorePackageUpdatesAsync(appUpdates);
    operation.Progress([](auto const&, StorePackageUpdateStatus const& progress) {
        emit("installing", static_cast<int>(std::clamp(progress.TotalDownloadProgress, 0.0, 1.0) * 100));
    });
    auto result = co_await operation;
    switch (result.OverallState()) {
        case StorePackageUpdateState::Completed: emit("updated"); break;
        case StorePackageUpdateState::Canceled: emit("canceled"); break;
        default: throw hresult_error(E_FAIL, L"Microsoft Store could not complete the update.");
    }
}

int wmain(int argc, wchar_t** argv) {
    try {
        init_apartment(apartment_type::single_threaded);
        if (argc != 3 || (std::wstring(argv[1]) != L"check" && std::wstring(argv[1]) != L"install")) {
            throw hresult_invalid_argument();
        }
        auto owner = reinterpret_cast<HWND>(std::stoull(argv[2]));
        if (!IsWindow(owner)) throw hresult_invalid_argument(L"A Muxus window is required.");
        auto operation = run(std::wstring(argv[1]) == L"install", owner);
        // Store UI needs an STA with a message pump. Blocking with .get() on this
        // thread would prevent async continuations and consent dialogs working.
        while (operation.Status() == AsyncStatus::Started) {
            MsgWaitForMultipleObjectsEx(0, nullptr, 100, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
            MSG message;
            while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        operation.GetResults();
        return 0;
    } catch (hresult_error const& error) {
        std::cerr << "Store update failed: 0x" << std::hex << static_cast<uint32_t>(error.code().value) << std::endl;
    } catch (std::exception const& error) {
        std::cerr << error.what() << std::endl;
    }
    emit("error");
    return 1;
}
