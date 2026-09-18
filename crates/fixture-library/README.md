# nightfall-fixture-library

A comprehensive fixture library management system for Nightfall that supports both GDTF and Open Fixture Library (OFL) formats. Automatically discovers, parses, and converts lighting fixture definitions from industry-standard formats into Nightfall's internal fixture representation.

## Features

- 📚 **Multi-Format Support**: Parse both GDTF (`.gdtf`) and OFL (`.json`) fixture files
- 🔍 **Automatic Discovery**: Scans platform-specific data directories for fixture files
- 🌐 **WebSocket Integration**: Full web UI integration with real-time updates
- 🎯 **Smart Conversion**: Intelligent attribute mapping and physical property extraction

### Supported Features by Format

### GDTF Format

- ✅ DMX mode extraction
- ✅ Attribute mapping (Dimmer, RGB, Pan/Tilt, Gobo, Prism, Shutter, etc.)
- ✅ Multi-element fixtures (LED bars with multiple pixels)
- ✅ Geometry-based element grouping
- ✅ Physical properties (beam angles, lumens, color temperature)
- ✅ DMX resolution detection (8/16/24-bit)
- ✅ Beam type mapping (Spot, Wash, Fresnel, PC)

### OFL Format

- ✅ Multi-mode fixture support
- ✅ Channel capability parsing
- ✅ Color intensity mapping (Red, Green, Blue, White, Amber, UV, etc.)
- ✅ Physical properties (dimensions, weight, power, optics)
- ✅ Beam type inference from categories
- ✅ DMX value parsing (numbers, strings, percentages)
- ✅ Custom attribute creation for unknown channels

## Adding Fixtures to Your Library

### 1. Find Your Library Directory

The fixture library uses platform-specific data directories:

- **Linux**: `~/.local/share/nightfall/fixtures/`
- **macOS**: `~/Library/Application Support/nightfall/fixtures/`
- **Windows**: `%APPDATA%\nightfall\fixtures\`

The directory is created automatically when the plugin initializes.

### 2. Download Fixture Files

**GDTF Fixtures:**

- Visit [GDTF Share](https://gdtf-share.com/)
- Download `.gdtf` files for your fixtures
- Place them in the fixtures directory

**OFL Fixtures:**

- Visit [Open Fixture Library](https://open-fixture-library.org/)
- Download fixture JSON files
- Name them following the pattern: `manufacturer@fixture-model.json`
  - Example: `chauvet-dj@intimidator-spot-260.json`

### 3. Automatic Detection

The library automatically:

- Scans for new files on startup
- Watches for file changes during runtime
- Broadcasts updates to connected web clients
- Handles file additions, modifications, and deletions

## Troubleshooting

### No Fixtures Found

1. Check that fixtures are in the correct directory
2. Verify file extensions (`.gdtf` or `.json`)
3. For OFL files, ensure filename follows `manufacturer@model.json` pattern
4. Check logs for parsing errors

### Fixture Creation Fails

1. Verify the mode name matches exactly (case-sensitive)
2. Check that the fixture file is valid GDTF/OFL
3. Look for conversion errors in logs
4. Try listing available modes first

### File Changes Not Detected

1. Ensure the watcher initialized successfully (check logs)
2. Verify the fixture directory exists
3. Check file permissions
4. Try manual refresh: `library.scan()`

## Developer Quick-Start

### Adding the Plugin

```rust
use bevy::prelude::*;
use nightfall_fixture_library::prelude::*;

fn main() {
    App::new()
        .add_plugins(FixtureLibraryPlugin)
        .run();
}
```

### Using the Library

```rust
use nightfall_fixture_library::prelude::*;

fn list_available_fixtures(library: Res<FixtureLibraryManager>) {
    for profile in library.list_fixtures() {
        println!("{} {} - {} modes",
            profile.make,
            profile.model,
            profile.mode_names().len()
        );
    }
}

fn create_fixture(library: Res<FixtureLibraryManager>) -> Result<Fixture> {
    library.create_fixture(
        "Chauvet DJ",           // Manufacturer
        "Intimidator Spot 260", // Model
        "14-channel",           // Mode name
        1                       // Fixture ID
    )
}
```

### Finding a Specific Fixture

```rust
fn find_and_create(library: Res<FixtureLibraryManager>) {
    if let Some(profile) = library.find_fixture("Chauvet DJ", "Intimidator Spot 260") {
        println!("Found fixture with modes: {:?}", profile.mode_names());

        // Get default mode
        if let Some(default_mode) = profile.default_mode() {
            match library.create_fixture(&profile.make, &profile.model, &default_mode, 1) {
                Ok(fixture) => println!("Created fixture with {} elements", fixture.elements.len()),
                Err(e) => eprintln!("Failed to create fixture: {}", e),
            }
        }
    }
}
```

### Error Handling

```rust
use nightfall_fixture_library::FixtureLibraryError;

fn handle_errors(library: Res<FixtureLibraryManager>) {
    match library.create_fixture("Unknown", "Fixture", "mode", 1) {
        Err(FixtureLibraryError::NotFound { make, model }) => {
            eprintln!("Fixture not found: {} {}", make, model);
        }
        Err(FixtureLibraryError::ModeNotFound { make, model, mode }) => {
            eprintln!("Mode '{}' not found for {} {}", mode, make, model);
        }
        Err(FixtureLibraryError::Io(e)) => {
            eprintln!("I/O error: {}", e);
        }
        Err(e) => eprintln!("Other error: {}", e),
        Ok(fixture) => println!("Success!"),
    }
}
```

## WebSocket API

The fixture library provides a WebSocket API for web UI integration. See [FIXTURE_LIBRARY_WEBSOCKET_API.md](../../docs/FIXTURE_LIBRARY_WEBSOCKET_API.md) for complete documentation.

### Available Commands

```typescript
// List all available fixtures
{
  "type": "ListAvailableFixtures"
}

// Get detailed fixture profile
{
  "type": "GetFixtureProfile",
  "data": {
    "make": "Chauvet DJ",
    "model": "Intimidator Spot 260"
  }
}

// Refresh library (manual rescan)
{
  "type": "RefreshLibrary"
}

// Create fixture from library
{
  "type": "CreateFixtureFromLibrary",
  "data": {
    "id": 1,
    "make": "Chauvet DJ",
    "model": "Intimidator Spot 260",
    "mode": "14-channel"
  }
}
```

## Architecture

### Key Components

```text
fixture-library/
├── manager.rs           # FixtureLibraryManager (main API)
├── scanner.rs           # File system scanning
├── watcher.rs           # File watching with notify crate
├── websocket.rs         # WebSocket command handlers
├── commands.rs          # WebSocket command definitions
├── converters/
│   ├── gdtf.rs         # GDTF to Fixture conversion
│   └── ofl.rs          # OFL to Fixture conversion
└── gdtf_metadata.rs    # Lightweight GDTF metadata
```

### Performance Considerations

- **Startup**: Library scan time depends on number of fixtures (~10ms per fixture)
- **File Watching**: Uses minimal CPU, only processes on file system events
- **Memory**: Metadata-only storage keeps memory usage low (~1KB per fixture)
- **Conversion**: Full conversion on-demand (~5-10ms per fixture)

## Contributing

When adding support for new fixture formats or attributes:

1. Add parser in `converters/`
2. Update `FixtureSource` enum in `manager.rs`
3. Add attribute mappings in converter modules
4. Write tests for the new functionality
5. Update documentation

### Testing

The library includes comprehensive test coverage:

```bash
# Run all tests
cargo test --package nightfall-fixture-library

# Run specific test suites
cargo test --package nightfall-fixture-library --lib converters::tests
cargo test --package nightfall-fixture-library --test integration_tests
cargo test --package nightfall-fixture-library --test websocket_tests
```

### Examples

See the `examples/` directory for working examples:

```bash
# Test fixture parsers
cargo run --example test_parsers -p nightfall-fixture-library

# Explore GDTF files
cargo run --example explore_gdtf -p nightfall-fixture-library

# Test fixture creation
cargo run --example test_fixture_creation -p nightfall-fixture-library
```

## License

See the workspace root for license information.

## Resources

- [GDTF Specification](https://github.com/mvrdevelopment/spec/blob/main/gdtf-spec.md)
- [OFL Specification](https://github.com/OpenLightingProject/open-fixture-library/blob/master/docs/fixture-format.md)
- [GDTF Share](https://gdtf-share.com/)
- [Open Fixture Library](https://open-fixture-library.org/)
- [WebSocket API Documentation](../../docs/FIXTURE_LIBRARY_WEBSOCKET_API.md)
- [Implementation Status](../../docs/FIXTURE_LIBRARY_STATUS.md)
