import base64
import json
from typing import Any

from boto3.dynamodb.conditions import Attr, Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError


class TaskAlreadyExistsError(Exception):
    pass


class TaskTableUnavailableError(Exception):
    pass


class TaskRepositoryValidationError(Exception):
    pass


class TaskRepository:
    def __init__(self, table: Any):
        self.table = table
        self.serializer = TypeSerializer()

    def create_with_state(self, item: dict[str, Any]) -> dict[str, Any]:
        client = self.table.meta.client
        state_key = {"PK": f"PROJECT#{item['project_id']}", "SK": "STATE"}
        task_item = {key: self.serializer.serialize(value) for key, value in item.items()}
        state_values = {":zero": self.serializer.serialize(0), ":one": self.serializer.serialize(1)}
        state_names = {
            "#total": "total_tasks",
            "#completed": "completed_tasks",
            "#in_progress": "in_progress_tasks",
            "#blocked": "blocked_tasks",
            "#entity": "entity_type",
            "#project": "project_id",
        }
        try:
            client.transact_write_items(
                TransactItems=[
                    {
                        "Put": {
                            "TableName": self.table.name,
                            "Item": task_item,
                            "ConditionExpression": "attribute_not_exists(PK) AND attribute_not_exists(SK)",
                        }
                    },
                    {
                        "Update": {
                            "TableName": self.table.name,
                            "Key": {
                                key: self.serializer.serialize(value)
                                for key, value in state_key.items()
                            },
                            "UpdateExpression": (
                                "SET #entity = if_not_exists(#entity, :state), "
                                "#project = if_not_exists(#project, :project_id), "
                                "#total = if_not_exists(#total, :zero) + :one, "
                                "#completed = if_not_exists(#completed, :zero), "
                                "#in_progress = if_not_exists(#in_progress, :zero), "
                                "#blocked = if_not_exists(#blocked, :zero)"
                            ),
                            "ExpressionAttributeNames": state_names,
                            "ExpressionAttributeValues": {
                                **state_values,
                                ":state": self.serializer.serialize("PROJECT_STATE"),
                                ":project_id": self.serializer.serialize(item["project_id"]),
                            },
                            "ConditionExpression": (
                                "attribute_not_exists(PK) OR "
                                "#entity = :state"
                            ),
                        }
                    },
                ]
            )
        except ClientError as error:
            code = error.response["Error"]["Code"]
            if code == "TransactionCanceledException":
                reasons = error.response.get("CancellationReasons", [])
                if reasons and reasons[0].get("Code") == "ConditionalCheckFailed":
                    raise TaskAlreadyExistsError from error
            self._raise_for_client_error(error)
            raise
        return item

    def get(self, project_id: str, task_id: str) -> dict[str, Any] | None:
        try:
            response = self.table.get_item(
                Key={"PK": f"PROJECT#{project_id}", "SK": f"TASK#{task_id}"}
            )
        except ClientError as error:
            self._raise_for_client_error(error)
            raise
        return response.get("Item")

    def query_project_tasks(
        self, project_id: str, limit: int, start_key: dict[str, Any] | None
    ) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
        return self._query_page(
            limit=limit,
            start_key=start_key,
            KeyConditionExpression=Key("PK").eq(f"PROJECT#{project_id}")
            & Key("SK").begins_with("TASK#"),
        )

    def query_employee_tasks(
        self,
        employee_id: str,
        limit: int,
        start_key: dict[str, Any] | None,
        project_id: str | None = None,
        status: str | None = None,
        priority: str | None = None,
    ) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
        filters = []
        if project_id:
            filters.append(Attr("project_id").eq(project_id))
        if status:
            filters.append(Attr("status").eq(status))
        if priority:
            filters.append(Attr("priority").eq(priority))
        return self._query_page(
            limit=limit,
            start_key=start_key,
            IndexName="EmployeeTasksIndex",
            KeyConditionExpression=Key("GSI1PK").eq(f"EMPLOYEE#{employee_id}"),
            FilterExpression=self._and_filters(filters),
        )

    def query_team_tasks(
        self,
        project_id: str,
        team_id: str,
        limit: int,
        start_key: dict[str, Any] | None,
    ) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
        return self._query_page(
            limit=limit,
            start_key=start_key,
            IndexName="TeamTasksIndex",
            KeyConditionExpression=Key("GSI2PK").eq(f"TEAM#{team_id}"),
            FilterExpression=Attr("project_id").eq(project_id),
        )

    def update(
        self,
        project_id: str,
        task_id: str,
        fields: dict[str, Any],
        remove_fields: list[str] | None = None,
    ) -> dict[str, Any] | None:
        remove_fields = remove_fields or []
        if not fields and not remove_fields:
            return self.get(project_id, task_id)
        names = {
            f"#{field}": field for field in [*fields.keys(), *remove_fields]
        }
        clauses = []
        values = {f":{field}": value for field, value in fields.items()}
        if fields:
            clauses.append("SET " + ", ".join(f"#{field} = :{field}" for field in fields))
        if remove_fields:
            clauses.append("REMOVE " + ", ".join(f"#{field}" for field in remove_fields))
        parameters = {
            "Key": {"PK": f"PROJECT#{project_id}", "SK": f"TASK#{task_id}"},
            "UpdateExpression": " ".join(clauses),
            "ExpressionAttributeNames": names,
            "ConditionExpression": "attribute_exists(PK) AND attribute_exists(SK)",
            "ReturnValues": "ALL_NEW",
        }
        if values:
            parameters["ExpressionAttributeValues"] = values
        try:
            response = self.table.update_item(**parameters)
        except ClientError as error:
            self._raise_for_client_error(error)
            if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return None
            raise
        return response.get("Attributes")

    def encode_key(self, key: dict[str, Any] | None) -> str | None:
        if not key:
            return None
        return base64.urlsafe_b64encode(
            json.dumps(key, separators=(",", ":"), sort_keys=True).encode()
        ).decode().rstrip("=")

    def decode_key(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        try:
            padding = "=" * (-len(token) % 4)
            key = json.loads(base64.urlsafe_b64decode(token + padding).decode())
            if not isinstance(key, dict) or not {"PK", "SK"}.issubset(key):
                raise ValueError
            return key
        except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise TaskRepositoryValidationError("Invalid next_token") from error

    def _query_page(self, limit: int, start_key: dict[str, Any] | None, **kwargs):
        parameters = {key: value for key, value in kwargs.items() if value is not None}
        parameters["Limit"] = limit
        if start_key:
            parameters["ExclusiveStartKey"] = start_key
        try:
            response = self.table.query(**parameters)
        except ClientError as error:
            self._raise_for_client_error(error)
            raise
        return response.get("Items", []), response.get("LastEvaluatedKey")

    @staticmethod
    def _and_filters(filters):
        if not filters:
            return None
        result = filters[0]
        for expression in filters[1:]:
            result = result & expression
        return result

    @staticmethod
    def _raise_for_client_error(error: ClientError) -> None:
        code = error.response["Error"]["Code"]
        if code == "ResourceNotFoundException":
            raise TaskTableUnavailableError from error
        if code == "ValidationException":
            raise TaskRepositoryValidationError(
                error.response["Error"].get("Message", "Invalid DynamoDB request")
            ) from error
