"""Push the Google Play listing text and images from support/store to Play Console.

Usage: play_listing.py <service-account.json> [package] [language]

Reads support/store/description.txt plus the images under support/store/play, then in one Play
edit replaces the listing's short/full description and its icon, feature graphic and phone,
7-inch and 10-inch screenshots, and commits it. The title is left as set in Play Console.
The Play API has no desktop screenshot type, so play/desktop is not uploaded.

Requires: pip install google-api-python-client google-auth
"""
import sys
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

from msstore_listing import DESCRIPTION, read_sections

PLAY = DESCRIPTION.parent / "play"
SCREENSHOTS = {
    "phoneScreenshots": "phone",
    "sevenInchScreenshots": "tablet-7",
    "tenInchScreenshots": "tablet-10",
}
SINGLES = {"icon": "icon-512.png", "featureGraphic": "feature-graphic-1024x500.png"}


def main():
    key = sys.argv[1]
    package = sys.argv[2] if len(sys.argv) > 2 else "net.zathu.majestictab"
    language = sys.argv[3] if len(sys.argv) > 3 else "en-US"
    text = read_sections(DESCRIPTION)

    creds = service_account.Credentials.from_service_account_file(
        key, scopes=["https://www.googleapis.com/auth/androidpublisher"])
    api = build("androidpublisher", "v3", credentials=creds, cache_discovery=False).edits()

    edit = api.insert(packageName=package, body={}).execute()["id"]
    listing = api.listings().get(packageName=package, editId=edit, language=language).execute()
    listing["shortDescription"] = text["Short description"]
    listing["fullDescription"] = text["Full description"]
    api.listings().update(packageName=package, editId=edit, language=language, body=listing).execute()

    def replace(image_type, files):
        api.images().deleteall(packageName=package, editId=edit, language=language, imageType=image_type).execute()
        for f in files:
            api.images().upload(packageName=package, editId=edit, language=language, imageType=image_type,
                                media_body=MediaFileUpload(str(f), mimetype="image/png")).execute()
        print(f"{image_type}: {len(files)} image(s)")

    for image_type, folder in SCREENSHOTS.items():
        replace(image_type, sorted((PLAY / folder).glob("*.png")))
    for image_type, name in SINGLES.items():
        replace(image_type, [PLAY / name])

    api.commit(packageName=package, editId=edit).execute()
    print(f"Committed {language} listing for {package}")


if __name__ == "__main__":
    main()
