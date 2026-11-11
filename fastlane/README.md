fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## Android

### android listing

```sh
[bundle exec] fastlane android listing
```

Sync the Play listing (text and images) without uploading a build

### android release

```sh
[bundle exec] fastlane android release
```

Upload the AAB, debug symbols and changelog, and sync the listing

----


## iOS

### ios beta

```sh
[bundle exec] fastlane ios beta
```

Upload dist/MajesticTab-ios.ipa to TestFlight (App Store Connect processes it, then it can be submitted)

### ios listing

```sh
[bundle exec] fastlane ios listing
```

Sync the iOS and iPad listing: text, promotional text and screenshots (no build, no submission)

----


## Mac

### mac beta

```sh
[bundle exec] fastlane mac beta
```

Upload dist/MajesticTab-appstore.pkg to TestFlight for macOS

### mac listing

```sh
[bundle exec] fastlane mac listing
```

Sync the Mac listing: text, promotional text and screenshots (no build, no submission)

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).
