import logging
import os

from fastapi import FastAPI
from mangum import Mangum

from app.api.employees import router as employee_router
from app.api.projects import router as project_router

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="ASTRA API", version="1.0.0")
app.include_router(employee_router)
app.include_router(project_router)

handler = Mangum(app)


if __name__ == "__main__":
	import uvicorn

	uvicorn.run(
		"app.main:app",
		host=os.getenv("HOST", "127.0.0.1"),
		port=int(os.getenv("PORT", "8003")),
		reload=True,
	)


