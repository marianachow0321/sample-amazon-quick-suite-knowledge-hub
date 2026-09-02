#!/usr/bin/env python3
"""Resets all Cognito users to random passwords and outputs a CSV file.

Usage:
    python3 reset_passwords.py <pool-id>
    python3 reset_passwords.py <pool-id> -o my_passwords.csv
"""

import argparse
import csv
import secrets
import string
import sys
from dataclasses import dataclass

import boto3
from botocore.client import BaseClient
from botocore.exceptions import BotoCoreError, ClientError


DEFAULT_OUTPUT = "passwords.csv"
PASSWORD_LENGTH = 12


def generate_password(length: int = PASSWORD_LENGTH) -> str:
    """Generates a random password that meets Cognito default policy."""
    lower = secrets.choice(string.ascii_lowercase)
    upper = secrets.choice(string.ascii_uppercase)
    digit = secrets.choice(string.digits)
    symbol = secrets.choice("!@#$%^&*()-_=+")
    rest = [
        secrets.choice(string.ascii_letters + string.digits + "!@#$%^&*()-_=+")
        for _ in range(length - 4)
    ]
    chars = list(lower + upper + digit + symbol) + rest
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


@dataclass
class UserRecord:
    username: str
    email: str
    status: str


def list_users(cognito_client: BaseClient, pool_id: str) -> list[UserRecord]:
    users = []
    paginator = cognito_client.get_paginator("list_users")
    for page in paginator.paginate(UserPoolId=pool_id):
        for user in page["Users"]:
            attrs = {a["Name"]: a["Value"] for a in user.get("Attributes", [])}
            users.append(
                UserRecord(
                    username=user["Username"],
                    email=attrs.get("email", ""),
                    status=user.get("UserStatus", ""),
                )
            )
    return users


def reset_passwords(
    cognito_client: BaseClient, pool_id: str, users: list[UserRecord], output_file: str
) -> None:
    results = []
    for user in users:
        password = generate_password()
        try:
            cognito_client.admin_set_user_password(
                UserPoolId=pool_id,
                Username=user.username,
                Password=password,
                Permanent=True,
            )
            results.append(
                {
                    "username": user.username,
                    "email": user.email,
                    "password": password,
                    "status": "OK",
                }
            )
            print(f"  OK: {user.username}")
        except (BotoCoreError, ClientError) as e:
            results.append(
                {
                    "username": user.username,
                    "email": user.email,
                    "password": "",
                    "status": f"FAILED: {e}",
                }
            )
            print(f"  FAILED: {user.username}: {e}")

    with open(output_file, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["username", "email", "password", "status"])
        writer.writeheader()
        writer.writerows(results)

    print(f"\nDone. {len(results)} users processed. Credentials saved to {output_file}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("pool_id", help="Cognito User Pool ID")
    parser.add_argument(
        "-o", "--output", default=DEFAULT_OUTPUT, help=f"Output CSV file (default: {DEFAULT_OUTPUT})"
    )
    args = parser.parse_args()

    session = boto3.Session()
    cognito = session.client("cognito-idp")
    pool_id = args.pool_id

    print(f"Pool: {pool_id}\n")

    users = list_users(cognito, pool_id)
    if not users:
        print("No users found.")
        return

    print(f"Found {len(users)} users:\n")
    for u in users:
        print(f"  {u.username:<30} {u.email:<40} {u.status}")

    confirm = input(f"\nReset passwords for all {len(users)} users? [y/n] ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        return

    print()
    reset_passwords(cognito, pool_id, users, args.output)


if __name__ == "__main__":
    try:
        main()
    except (BotoCoreError, ClientError) as e:
        sys.exit(f"ERROR: {e}")
    except Exception as e:
        sys.exit(f"UNEXPECTED ERROR: {e}")
