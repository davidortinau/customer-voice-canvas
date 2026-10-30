"""Use the desktop portal's native file chooser without copying response files."""
import asyncio
import json
import signal
import sys
import uuid
from pathlib import Path
from urllib.parse import unquote, urlsplit

from dbus_next import Message, MessageType, Variant
from dbus_next.aio import MessageBus


async def pick_file():
    bus = await MessageBus().connect()
    token = "customer_voice_" + uuid.uuid4().hex
    sender = bus.unique_name.lstrip(":").replace(".", "_")
    handle = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
    response = asyncio.get_running_loop().create_future()

    def receive(message):
        if (message.message_type == MessageType.SIGNAL and message.path == handle
                and message.interface == "org.freedesktop.portal.Request"
                and message.member == "Response" and not response.done()):
            response.set_result(message.body)

    bus.add_message_handler(receive)
    try:
        rule = (f"type='signal',sender='org.freedesktop.portal.Desktop',path='{handle}',"
                "interface='org.freedesktop.portal.Request',member='Response'")
        subscribed = await bus.call(Message(destination="org.freedesktop.DBus",
            path="/org/freedesktop/DBus", interface="org.freedesktop.DBus",
            member="AddMatch", signature="s", body=[rule]))
        if subscribed.message_type == MessageType.ERROR:
            raise RuntimeError(f"Cannot subscribe to the desktop portal: {subscribed.error_name}")
        try:
            opened = await bus.call(Message(destination="org.freedesktop.portal.Desktop",
                path="/org/freedesktop/portal/desktop", interface="org.freedesktop.portal.FileChooser",
                member="OpenFile", signature="ssa{sv}", body=["", "Select a survey export", {
                    "handle_token": Variant("s", token),
                    "multiple": Variant("b", False),
                    "filters": Variant("a(sa(us))", [["Survey exports", [
                        [0, "*.[cC][sS][vV]"], [0, "*.[xX][lL][sS][xX]"]]]]),
                }]))
            if opened.message_type == MessageType.ERROR:
                raise RuntimeError(f"Desktop file chooser unavailable ({opened.error_name}). "
                                   "Enable xdg-desktop-portal and the desktop backend.")
            if opened.body != [handle]:
                raise RuntimeError("The desktop portal returned an unexpected request handle.")
            code, results = await asyncio.wait_for(response, timeout=240)
        except (TimeoutError, asyncio.CancelledError) as error:
            closed = await bus.call(Message(destination="org.freedesktop.portal.Desktop",
                path=handle, interface="org.freedesktop.portal.Request", member="Close"))
            if closed.message_type == MessageType.ERROR:
                raise RuntimeError(f"Cannot close the desktop dialog ({closed.error_name}).")
            if isinstance(error, asyncio.CancelledError):
                raise RuntimeError("File selection cancelled.")
            raise RuntimeError("File selection timed out. Select Browse files to try again.")
        if code == 1:
            return {"path": None}
        if code != 0:
            raise RuntimeError("The desktop file chooser failed.")
        uris = results.get("uris")
        if uris is None or len(uris.value) != 1:
            raise RuntimeError("Select one local CSV or XLSX file.")
        uri = urlsplit(uris.value[0])
        path = unquote(uri.path)
        if (uri.scheme != "file" or uri.netloc not in ("", "localhost")
                or not Path(path).is_absolute() or Path(path).suffix.lower() not in (".csv", ".xlsx")):
            raise RuntimeError("Select a local CSV or XLSX file.")
        return {"path": path}
    finally:
        bus.disconnect()


async def main():
    task = asyncio.create_task(pick_file())
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
    return await task


if __name__ == "__main__":
    try:
        print(json.dumps(asyncio.run(main())))
    except Exception as error:
        print(json.dumps({"error": f"Native file selection failed: {error}"}))
        sys.exit(1)
