"""Exercise the actual Linux helper against a private, simulated portal."""
import asyncio
import json
import os
from pathlib import Path
import sys

from dbus_next import Message, MessageType, Variant
from dbus_next.aio import MessageBus
from dbus_next.service import ServiceInterface, method


async def main():
    bus = await MessageBus().connect()
    await bus.request_name("org.freedesktop.portal.Desktop")
    response_code = 0
    response_uri = "file:///tmp/survey%20export.xlsx"
    opened = asyncio.Event()
    closed = asyncio.Event()

    class Request(ServiceInterface):
        def __init__(self):
            super().__init__("org.freedesktop.portal.Request")

        @method()
        def Close(self):
            closed.set()

    class Portal(ServiceInterface):
        def __init__(self):
            super().__init__("org.freedesktop.portal.FileChooser")

        @method()
        def OpenFile(self, parent: "s", title: "s", options: "a{sv}") -> "o":
            assert title == "Select a survey export"
            assert options["multiple"].value is False
            assert options["filters"].signature == "a(sa(us))"
            # The request sender is the helper's unique connection, captured below.
            handle = f"/org/freedesktop/portal/desktop/request/{request_sender}/{options['handle_token'].value}"
            bus.export(handle, Request())
            if response_code is not None:
                # Emit before OpenFile returns, to exercise the subscription race.
                bus.send(Message(path=handle, interface="org.freedesktop.portal.Request", member="Response",
                    message_type=MessageType.SIGNAL, signature="ua{sv}",
                    body=[response_code, {"uris": Variant("as", [response_uri])}]))
            opened.set()
            return handle

    request_sender = ""

    def observe(message):
        nonlocal request_sender
        if message.member == "OpenFile":
            request_sender = message.sender.lstrip(":").replace(".", "_")

    bus.add_message_handler(observe)
    bus.export("/org/freedesktop/portal/desktop", Portal())
    plugin = Path(os.environ.get("CUSTOMER_VOICE_PLUGIN_ROOT", "dist/plugin"))
    helper = plugin / "extensions/customer-voice/runtime/cv-file-picker/cv-file-picker"
    command = [sys.executable, "extensions/customer-voice/file-picker-linux.py"] if "--source" in sys.argv else [str(helper.resolve())]

    async def run():
        process = await asyncio.create_subprocess_exec(*command,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=20)
        return process.returncode, json.loads(stdout), stderr

    try:
        code, result, _ = await run()
        assert code == 0 and result == {"path": "/tmp/survey export.xlsx"}, result
        response_code = 1
        code, result, _ = await run()
        assert code == 0 and result == {"path": None}, result
        response_code = 0
        response_uri = "https://example.test/not-a-local-file.csv"
        code, result, _ = await run()
        assert code != 0 and "local CSV or XLSX" in result["error"], result
        response_code = 2
        code, result, _ = await run()
        assert code != 0 and "chooser failed" in result["error"], result
        response_code = None
        opened.clear()
        process = await asyncio.create_subprocess_exec(*command,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            await asyncio.wait_for(opened.wait(), timeout=10)
            process.terminate()
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=10)
            assert process.returncode != 0 and "cancelled" in json.loads(stdout)["error"]
            assert closed.is_set(), "Closing the helper must close its portal request."
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        await bus.release_name("org.freedesktop.portal.Desktop")
        code, result, _ = await run()
        assert code != 0 and "unavailable" in result["error"], result
        print("Linux portal transport passed: early response, selection, cancel, failure, nonlocal URI rejection, close on termination, and missing portal (simulated desktop portal).")
    finally:
        bus.disconnect()


asyncio.run(main())
