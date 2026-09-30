from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError


class MembershipAlreadyExistsError(Exception):
    pass


class MembershipTableUnavailableError(Exception):
    pass


class MembershipRepositoryValidationError(Exception):
    pass


class MembershipRepository:
    def __init__(self, table: Any):
        self.table = table

    def create(self, item: dict[str, Any]) -> dict[str, Any]:
        try:
            self.table.put_item(
                Item=item,
                ConditionExpression="attribute_not_exists(PK) AND attribute_not_exists(SK)",
            )
        except ClientError as error:
            self._raise_for_client_error(error)
            if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise MembershipAlreadyExistsError from error
            raise
        return item

    def get(self, project_id: str, sort_key: str) -> dict[str, Any] | None:
        try:
            response = self.table.get_item(
                Key={"PK": f"PROJECT#{project_id}", "SK": sort_key}
            )
        except ClientError as error:
            self._raise_for_client_error(error)
            raise
        return response.get("Item")

    def query_project_teams(self, project_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"PROJECT#{project_id}")
            & Key("SK").begins_with("TEAM#")
        )

    def query_project_employees(self, project_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"PROJECT#{project_id}")
            & Key("SK").begins_with("EMPLOYEE#")
        )

    def query_employee_projects(self, employee_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            IndexName="EmployeeProjectsIndex",
            KeyConditionExpression=Key("GSI1PK").eq(f"EMPLOYEE#{employee_id}")
            & Key("GSI1SK").begins_with("PROJECT#"),
        )

    def query_team_employees(
        self, project_id: str, team_id: str
    ) -> list[dict[str, Any]]:
        return self._query_all(
            IndexName="ProjectTeamEmployeesIndex",
            KeyConditionExpression=Key("GSI2PK").eq(
                f"PROJECT#{project_id}#TEAM#{team_id}"
            ),
        )

    def update(
        self,
        project_id: str,
        sort_key: str,
        fields: dict[str, Any],
        remove_fields: list[str] | None = None,
    ) -> dict[str, Any] | None:
        remove_fields = remove_fields or []
        if not fields and not remove_fields:
            return self.get(project_id, sort_key)

        expression_names = {
            f"#{field.replace('#', '_')}": field for field in fields
        }
        expression_names.update(
            {f"#{field.replace('#', '_')}": field for field in remove_fields}
        )
        clauses: list[str] = []
        if fields:
            expression_values = {
                f":{field}": value for field, value in fields.items()
            }
            clauses.append(
                "SET "
                + ", ".join(
                    f"#{field.replace('#', '_')} = :{field}"
                    for field in fields
                )
            )
        else:
            expression_values = {}
        if remove_fields:
            clauses.append(
                "REMOVE "
                + ", ".join(
                    f"#{field.replace('#', '_')}" for field in remove_fields
                )
            )

        parameters: dict[str, Any] = {
            "Key": {"PK": f"PROJECT#{project_id}", "SK": sort_key},
            "UpdateExpression": " ".join(clauses),
            "ExpressionAttributeNames": expression_names,
            "ConditionExpression": "attribute_exists(PK) AND attribute_exists(SK)",
            "ReturnValues": "ALL_NEW",
        }
        if expression_values:
            parameters["ExpressionAttributeValues"] = expression_values
        try:
            response = self.table.update_item(**parameters)
        except ClientError as error:
            self._raise_for_client_error(error)
            if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return None
            raise
        return response.get("Attributes")

    def delete(self, project_id: str, sort_key: str) -> bool:
        try:
            self.table.delete_item(
                Key={"PK": f"PROJECT#{project_id}", "SK": sort_key},
                ConditionExpression="attribute_exists(PK) AND attribute_exists(SK)",
            )
        except ClientError as error:
            self._raise_for_client_error(error)
            if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise
        return True

    def _query_all(self, **parameters: Any) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        while True:
            try:
                response = self.table.query(**parameters)
            except ClientError as error:
                self._raise_for_client_error(error)
                raise
            items.extend(response.get("Items", []))
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                return items
            parameters["ExclusiveStartKey"] = last_key

    @staticmethod
    def _raise_for_client_error(error: ClientError) -> None:
        code = error.response["Error"]["Code"]
        if code == "ResourceNotFoundException":
            raise MembershipTableUnavailableError from error
        if code == "ValidationException":
            raise MembershipRepositoryValidationError(
                error.response["Error"].get("Message", "Invalid DynamoDB request")
            ) from error
