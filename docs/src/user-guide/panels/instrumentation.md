# Instrumentation

{{#include ../../includes/human-review-disclaimer.md}}

Instrumentation displays runtime measurements for diagnosing responsiveness and update problems. Open it from the Command Palette after reproducing the behavior you want to inspect.

Compare frontend and backend activity, frame/update measurements, and transport-related statistics shown by the panel. Observe an idle baseline, perform the troublesome action, then note which values change. Keep the fixture count, open panels, and active playback comparable between observations.

A connected UI can still be waiting on a slow operation; a high update rate also does not prove the visualizer is rendering correctly. Check the visible result alongside measurements. Use Console for command errors and the connection indicator for transport state.

For a useful bug report, record the application version, operating system, reproduction steps, and a screenshot of the relevant measurements. Remove private show labels or local paths before sharing screenshots or logs. More targeted developer options are described in the developer reference.
