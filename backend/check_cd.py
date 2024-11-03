# backend/check_cd.py
import os
import discid
import sys

def check_cd_drive():
    print("Checking CD drive status...")
    
    # Check if device exists
    if not os.path.exists('/dev/cdrom'):
        print("ERROR: /dev/cdrom does not exist")
        return False

    # Check permissions
    try:
        print(f"CD device permissions: {oct(os.stat('/dev/cdrom').st_mode)[-3:]}")
    except Exception as e:
        print(f"ERROR checking permissions: {e}")

    # Try to read disc ID
    try:
        disc = discid.read('/dev/cdrom')
        print(f"Successfully read disc ID: {disc.id}")
        return True
    except Exception as e:
        print(f"ERROR reading disc: {e}")
        return False

if __name__ == "__main__":
    check_cd_drive()
