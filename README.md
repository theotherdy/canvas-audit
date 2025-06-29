# Canvas Course Audit Tool

A Laravel-based application for auditing Canvas LMS courses. This tool helps admin staff analyze course content, engagement metrics, and activity levels across multiple Canvas courses.

## Features

- **Course Content Audit**: Count published pages, quizzes, assignments, and discussions
- **Engagement Analysis**: Calculate student engagement ratios for different content types
- **Batch Processing**: Audit multiple courses simultaneously
- **Debug Tools**: Comprehensive debugging interface for troubleshooting API issues
- **Detailed Logging**: Separate logging for Canvas API interactions

## Quick Start

1. **Install Dependencies**
   ```bash
   composer install
   npm install
   ```

2. **Environment Setup**
   ```bash
   cp .env.example .env
   php artisan key:generate
   ```

3. **Configure Canvas API**
   Add to your `.env` file:
   ```
   CANVAS_BASE_URL=https://your-canvas-instance.instructure.com/api/v1
   CANVAS_API_TOKEN=your_canvas_api_token
   ```

4. **Run Migrations**
   ```bash
   php artisan migrate
   ```

5. **Start the Application**
   ```bash
   php artisan serve
   ```

## Usage

### Running Audits

1. Navigate to the home page
2. Enter course IDs (comma or space separated)
3. Click "Start audit"
4. View results in the table

### Debug Tools

Access the debug interface at `/debug` to:

- **Check Configuration**: Verify Canvas API settings
- **Test API Connection**: Test basic Canvas API connectivity
- **Test Course Endpoints**: Test individual course API endpoints
- **View Logs**: Browse recent Laravel and Canvas API logs

## Debugging

### Common Issues

1. **API Connection Failures**
   - Check Canvas base URL and API token in `.env`
   - Use debug tools to test connection
   - Verify API token has appropriate permissions

2. **Course Access Issues**
   - Ensure API token has access to the specified courses
   - Check course IDs are correct
   - Use debug tools to test individual course endpoints

3. **Performance Issues**
   - Large courses may take time to audit
   - Check Canvas API rate limits
   - Monitor logs for timeout issues

### Log Files

- **Laravel Logs**: `storage/logs/laravel.log`
- **Canvas API Logs**: `storage/logs/canvas.log`

### Debug Interface

The debug interface provides:
- Real-time configuration status
- API connection testing
- Individual endpoint testing
- Log file viewing

## API Endpoints Used

The application interacts with these Canvas API endpoints:

- `/courses/{id}` - Course information
- `/courses/{id}/enrollments` - Student enrollments
- `/courses/{id}/pages` - Course pages
- `/courses/{id}/quizzes` - Course quizzes
- `/courses/{id}/assignments` - Course assignments
- `/courses/{id}/discussion_topics` - Course discussions
- `/courses/{id}/quizzes/{quiz_id}/submissions` - Quiz submissions
- `/courses/{id}/assignments/{assignment_id}/submissions` - Assignment submissions
- `/courses/{id}/discussion_topics/{topic_id}/entries` - Discussion entries

## Development

### Adding New Audit Metrics

1. Add new counting method to `CanvasCourseAuditor`
2. Update the `run()` method to include new metric
3. Update the results view to display new data
4. Add appropriate logging

### Testing

```bash
php artisan test
```

### Code Style

```bash
./vendor/bin/pint
```

## License

This project is open-sourced software licensed under the [MIT license](https://opensource.org/licenses/MIT).
