import base64
import json
from typing import Any

from botocore.exceptions import ClientError


class ProjectAlreadyExistsError(Exception):
    pass


class ProjectTableUnavailableError(Exception):
    pass


class ProjectRepositoryValidationError(Exception):
    pass


class ProjectRepository:
    def __init__(self, table: Any):
        self.table = table

    def create(self, item: dict[str, Any]) -> dict[str, Any]:
        try:
            self.table.put_item(
                Item=item,
                ConditionExpression="attribute_not_exists(project_id)",
            )
        except ClientError as error:
            self._raise_for_client_error(error)
            if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise ProjectAlreadyExistsError from error
            raise
        return item

    def get(self, project_id: str) -> dict[str, Any] | None:
        try:
            response = self.table.get_item(Key={"project_id": project_id})
        except ClientError as error:
            self._raise_for_client_error(error)
            raise
        return response.get("Item")

    def list(
        self, limit: int, exclusive_start_key: dict[str, Any] | None
    ) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
        parameters: dict[str, Any] = {"Limit": limit}
        if exclusive_start_key:
            parameters["ExclusiveStartKey"] = exclusive_start_key
        try:
            response = self.table.scan(**parameters)
        except ClientError as error:
            self._raise_for_client_error(error)
            raise
        return response.get("Items", []), response.get("LastEvaluatedKey")

    def update(
        self, project_id: str, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        if not fields:
            return self.get(project_id)

        expression_names = {f"#{field}": field for field in fields}
        expression_values = {
            f":{field}": value for field, value in fields.items()
        }
        assignments = ", ".join(
            f"#{field} = :{field}" for field in fields
        )
        try:
            response = self.table.update_item(
                Key={"project_id": project_id},
                UpdateExpression=f"SET {assignments}",
                ExpressionAttributeNames=expression_names,
                ExpressionAttributeValues=expression_values,
                ConditionExpression="attribute_exists(project_id)",
                ReturnValues="ALL_NEW",
            )
        except ClientError as error:
            self._raise_for_client_error(error)
            if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return None
            raise
        return response.get("Attributes")

    @staticmethod
    def encode_key(key: dict[str, Any] | None) -> str | None:
        if not key:
            return None
        payload = json.dumps(key, separators=(",", ":"), sort_keys=True).encode()
        return base64.urlsafe_b64encode(payload).decode().rstrip("=")

    @staticmethod
    def decode_key(token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        try:
            padding = "=" * (-len(token) % 4)
            value = base64.urlsafe_b64decode(f"{token}{padding}")
            key = json.loads(value.decode())
            if not isinstance(key, dict) or set(key) != {"project_id"}:
                raise ValueError
            return key
        except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProjectRepositoryValidationError("Invalid next_token") from error

    @staticmethod
    def _raise_for_client_error(error: ClientError) -> None:
        code = error.response["Error"]["Code"]
        if code == "ResourceNotFoundException":
            raise ProjectTableUnavailableError from error
        if code == "ValidationException":
            raise ProjectRepositoryValidationError(
                error.response["Error"].get("Message", "Invalid DynamoDB request")
            ) from error
